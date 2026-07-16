use std::{
    collections::HashMap,
    env,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    path::BaseDirectory,
    AppHandle, Manager, State,
};

const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;
const MIN_RENDER_WIDTH: i32 = 64;
const MAX_RENDER_WIDTH: i32 = 4096;
const MAX_RENDER_HEIGHT: i32 = 4096;

#[cfg(target_os = "windows")]
const PDFIUM_LIBRARY_NAME: &str = "pdfium.dll";
#[cfg(target_os = "macos")]
const PDFIUM_LIBRARY_NAME: &str = "libpdfium.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const PDFIUM_LIBRARY_NAME: &str = "libpdfium.so";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocumentInfo {
    id: u64,
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
}

#[derive(Serialize)]
struct PdfPageInfo {
    width: f32,
    height: f32,
}

/// A run of text on a page together with its bounding box, expressed in PDF
/// points with a top-left origin so the frontend can overlay a selectable text
/// layer on top of the rendered page image.
#[derive(Serialize)]
pub struct PdfTextSpan {
    text: String,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfOutlineItem {
    title: String,
    page_number: Option<i32>,
    items: Vec<PdfOutlineItem>,
}

struct PdfiumEngine {
    pdfium: &'static Pdfium,
    documents: Mutex<HashMap<u64, PdfDocument<'static>>>,
    next_document_id: AtomicU64,
}

#[derive(Clone)]
pub struct PdfiumState(Arc<PdfiumEngine>);

impl PdfiumState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let bindings = bind_pdfium(app)?;
        let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));

        Ok(Self(Arc::new(PdfiumEngine {
            pdfium,
            documents: Mutex::new(HashMap::new()),
            next_document_id: AtomicU64::new(1),
        })))
    }
}

impl PdfiumEngine {
    fn open(&self, bytes: Vec<u8>) -> Result<PdfDocumentInfo, String> {
        if bytes.is_empty() {
            return Err("PDF file is empty".into());
        }

        if bytes.len() > MAX_PDF_BYTES {
            return Err(format!(
                "PDF file exceeds the {} MiB limit",
                MAX_PDF_BYTES / 1024 / 1024
            ));
        }

        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not open the document: {error}"))?;
        let pages = document
            .pages()
            .iter()
            .map(|page| PdfPageInfo {
                width: page.width().value,
                height: page.height().value,
            })
            .collect::<Vec<_>>();
        let num_pages = document.pages().len();
        let outline = collect_bookmark_siblings(document.bookmarks().root());
        let id = self.next_document_id.fetch_add(1, Ordering::Relaxed);

        self.documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?
            .insert(id, document);

        Ok(PdfDocumentInfo {
            id,
            num_pages,
            pages,
            outline,
        })
    }

    fn render_page(
        &self,
        document_id: u64,
        page_number: i32,
        width: i32,
    ) -> Result<Vec<u8>, String> {
        if !(MIN_RENDER_WIDTH..=MAX_RENDER_WIDTH).contains(&width) {
            return Err(format!(
                "render width must be between {MIN_RENDER_WIDTH} and {MAX_RENDER_WIDTH} pixels"
            ));
        }

        let documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let document = documents
            .get(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        if page_number < 1 || page_number > document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let render_config = PdfRenderConfig::new()
            .set_target_width(width)
            .set_maximum_width(MAX_RENDER_WIDTH)
            .set_maximum_height(MAX_RENDER_HEIGHT)
            .render_annotations(true)
            .render_form_data(true);
        let image = page
            .render_with_config(&render_config)
            .and_then(|bitmap| bitmap.as_image())
            .map_err(|error| format!("PDFium could not render page {page_number}: {error}"))?;
        let mut png = Cursor::new(Vec::new());

        image
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|error| format!("could not encode page {page_number}: {error}"))?;

        Ok(png.into_inner())
    }

    fn extract_text(&self, document_id: u64, page_number: i32) -> Result<Vec<PdfTextSpan>, String> {
        let documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let document = documents
            .get(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        if page_number < 1 || page_number > document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let page_height = page.height().value;
        let text = page.text().map_err(|error| {
            format!("PDFium could not read text on page {page_number}: {error}")
        })?;
        let mut spans = Vec::new();

        for segment in text.segments().iter() {
            let content = segment.text();

            if content.is_empty() {
                continue;
            }

            let bounds = segment.bounds();
            let left = bounds.left().value;
            let top = bounds.top().value;
            let width = bounds.right().value - left;
            let height = top - bounds.bottom().value;

            if !(width > 0.0 && height > 0.0) {
                continue;
            }

            spans.push(PdfTextSpan {
                text: content,
                left,
                // PDFium uses a bottom-left origin; flip to top-left for the DOM.
                top: page_height - top,
                width,
                height,
            });
        }

        Ok(spans)
    }

    fn close(&self, document_id: u64) -> Result<(), String> {
        self.documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?
            .remove(&document_id);

        Ok(())
    }
}

fn collect_bookmark_siblings(mut bookmark: Option<PdfBookmark<'_>>) -> Vec<PdfOutlineItem> {
    let mut items = Vec::new();

    while let Some(current) = bookmark {
        let page_number = current
            .destination()
            .and_then(|destination| destination.page_index().ok())
            .map(|page_index| page_index + 1);
        let children = collect_bookmark_siblings(current.first_child());

        items.push(PdfOutlineItem {
            title: current.title().unwrap_or_default(),
            page_number,
            items: children,
        });
        bookmark = current.next_sibling();
    }

    items
}

fn bind_pdfium(app: &AppHandle) -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let candidates = pdfium_library_candidates(app);
    let mut failures = Vec::new();

    for path in candidates {
        if !path.is_file() {
            continue;
        }

        match Pdfium::bind_to_library(&path) {
            Ok(bindings) => return Ok(bindings),
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }

    let details = if failures.is_empty() {
        String::new()
    } else {
        format!(" Attempts: {}", failures.join("; "))
    };

    Err(format!(
        "PDFium runtime was not found. Run `bun run pdfium:download` or set PDFIUM_LIB_PATH.{details}"
    ))
}

fn pdfium_library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("PDFIUM_LIB_PATH") {
        candidates.push(library_path(PathBuf::from(path)));
    }

    if let Ok(resource_path) = app.path().resolve(
        Path::new("pdfium").join(PDFIUM_LIBRARY_NAME),
        BaseDirectory::Resource,
    ) {
        candidates.push(resource_path);
    }

    if let Ok(executable_path) = env::current_exe() {
        if let Some(executable_directory) = executable_path.parent() {
            candidates.push(executable_directory.join(PDFIUM_LIBRARY_NAME));
        }
    }

    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium")
            .join(PDFIUM_LIBRARY_NAME),
    );
    candidates.into_iter().fold(Vec::new(), |mut unique, path| {
        if !unique.contains(&path) {
            unique.push(path);
        }

        unique
    })
}

fn library_path(path: PathBuf) -> PathBuf {
    if path.is_dir() {
        path.join(PDFIUM_LIBRARY_NAME)
    } else {
        path
    }
}

#[tauri::command]
pub async fn open_pdf(
    request: Request<'_>,
    state: State<'_, PdfiumState>,
) -> Result<PdfDocumentInfo, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("open_pdf requires a raw PDF byte payload".into());
    };

    if bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF file exceeds the {} MiB limit",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }

    let bytes = bytes.clone();
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.open(bytes))
        .await
        .map_err(|error| format!("PDFium open task failed: {error}"))?
}

#[tauri::command]
pub async fn render_pdf_page(
    document_id: u64,
    page_number: i32,
    width: i32,
    state: State<'_, PdfiumState>,
) -> Result<Response, String> {
    let engine = Arc::clone(&state.0);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        engine.render_page(document_id, page_number, width)
    })
    .await
    .map_err(|error| format!("PDFium render task failed: {error}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn extract_pdf_page_text(
    document_id: u64,
    page_number: i32,
    state: State<'_, PdfiumState>,
) -> Result<Vec<PdfTextSpan>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.extract_text(document_id, page_number))
        .await
        .map_err(|error| format!("PDFium text extraction task failed: {error}"))?
}

#[tauri::command]
pub fn close_pdf(document_id: u64, state: State<'_, PdfiumState>) -> Result<(), String> {
    state.0.close(document_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_pdf() -> Vec<u8> {
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n",
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();

        for object in objects {
            offsets.push(pdf.len());
            pdf.extend_from_slice(object.as_bytes());
        }

        let xref_offset = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");

        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }

        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn opens_and_renders_pdf_with_pdfium() {
        let library_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium")
            .join(PDFIUM_LIBRARY_NAME);
        let bindings = Pdfium::bind_to_library(&library_path)
            .unwrap_or_else(|error| panic!("could not load {}: {error}", library_path.display()));
        let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
        let engine = PdfiumEngine {
            pdfium,
            documents: Mutex::new(HashMap::new()),
            next_document_id: AtomicU64::new(1),
        };

        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        assert_eq!(document.num_pages, 1);
        assert_eq!(document.pages.len(), 1);

        let png = engine
            .render_page(document.id, 1, 400)
            .expect("PDFium should render the page");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

        // The minimal PDF carries no page content, so it has no selectable text.
        let spans = engine
            .extract_text(document.id, 1)
            .expect("PDFium should extract text");
        assert!(spans.is_empty());
    }
}
