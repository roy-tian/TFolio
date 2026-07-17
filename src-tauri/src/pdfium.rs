use std::{
    collections::HashMap,
    env, fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use image::{DynamicImage, ImageFormat};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    path::BaseDirectory,
    AppHandle, Manager, State,
};

const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;
const MIN_RENDER_WIDTH: i32 = 64;
const MAX_RENDER_WIDTH: i32 = 4096;
const MAX_RENDER_HEIGHT: i32 = 4096;
// Thumbnails are decorative navigation targets, never read at full size, so they
// get a much tighter ceiling than a full page render.
const MAX_THUMBNAIL_WIDTH: i32 = 512;
// Each quad is a PDFium call made under the lock every render waits on, and no
// page has this many runs of text.
const MAX_HIGHLIGHT_QUADS: usize = 8192;

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
    // `width`/`height` are the displayed dimensions (the page's intrinsic
    // `/Rotate` already applied), matching the rendered bitmap. `rotation` is
    // the clockwise rotation in degrees (0/90/180/270) so the frontend can
    // orient the text layer to match.
    width: f32,
    height: f32,
    rotation: f32,
}

/// A run of text on a page together with its bounding box, expressed in
/// *unrotated* page points with a top-left origin. The frontend rotates the
/// whole text layer by the page's rotation, so spans stay in unrotated space.
#[derive(Serialize)]
pub struct PdfTextSpan {
    text: String,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

/// A rectangle in the same space `PdfTextSpan` reports text in: *unrotated* page
/// points with a top-left origin. Every annotation is placed in these terms, so
/// a caller never has to know which way PDFium counts its own axes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePointsRect {
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

struct OpenDocument {
    document: PdfDocument<'static>,
    /// How many annotations this session has added to each page.
    ///
    /// PDFium appends, so the reader's own marks are the tail of a page's
    /// annotations and this is how long that tail is. Past it lie the document's
    /// own — links, form fields, comments — which an undo must never reach.
    added: HashMap<i32, u32>,
}

struct PdfiumEngine {
    pdfium: &'static Pdfium,
    /// The open documents, and — load-bearing beyond that — the lock that
    /// serializes PDFium itself.
    ///
    /// PDFium is not safe to call from two threads at once, and `pdfium-render`
    /// does not make it so: `thread_safe` only marks the bindings `Send + Sync`,
    /// promising the caller will serialize them. Commands run their PDFium work
    /// in `spawn_blocking`, so without this lock two of them would corrupt the
    /// heap. Hold it across *all* PDFium work, including opening a document —
    /// which touches every page before there is anything to insert here.
    documents: Mutex<HashMap<u64, OpenDocument>>,
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

        // Before PDFium is touched, not just around the insert: reading the new
        // document's pages and bookmarks is PDFium work like any other.
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
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
                rotation: page_rotation_degrees(&page),
            })
            .collect::<Vec<_>>();
        let num_pages = document.pages().len();
        let outline = collect_bookmark_siblings(document.bookmarks().root());
        let id = self.next_document_id.fetch_add(1, Ordering::Relaxed);

        documents.insert(
            id,
            OpenDocument {
                added: HashMap::new(),
                document,
            },
        );

        Ok(PdfDocumentInfo {
            id,
            num_pages,
            pages,
            outline,
        })
    }

    /// Renders `page_number` to a bitmap `width` pixels wide, refusing anything
    /// wider than `max_width`. Shared by the full-page and thumbnail paths,
    /// which differ only in their ceiling and their encoder.
    fn render_bitmap(
        &self,
        document_id: u64,
        page_number: i32,
        width: i32,
        max_width: i32,
    ) -> Result<DynamicImage, String> {
        if !(MIN_RENDER_WIDTH..=max_width).contains(&width) {
            return Err(format!(
                "render width must be between {MIN_RENDER_WIDTH} and {max_width} pixels"
            ));
        }

        let documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let document = &documents
            .get(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?
            .document;

        if page_number < 1 || page_number > document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let render_config = PdfRenderConfig::new()
            .set_target_width(width)
            .set_maximum_width(max_width)
            .set_maximum_height(MAX_RENDER_HEIGHT)
            .render_annotations(true)
            .render_form_data(true);

        page.render_with_config(&render_config)
            .and_then(|bitmap| bitmap.as_image())
            .map_err(|error| format!("PDFium could not render page {page_number}: {error}"))
    }

    fn render_page(
        &self,
        document_id: u64,
        page_number: i32,
        width: i32,
    ) -> Result<Vec<u8>, String> {
        let image = self.render_bitmap(document_id, page_number, width, MAX_RENDER_WIDTH)?;
        let mut png = Cursor::new(Vec::new());

        image
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|error| format!("could not encode page {page_number}: {error}"))?;

        Ok(png.into_inner())
    }

    fn render_thumbnail(
        &self,
        document_id: u64,
        page_number: i32,
        width: i32,
    ) -> Result<Vec<u8>, String> {
        let image = self.render_bitmap(document_id, page_number, width, MAX_THUMBNAIL_WIDTH)?;
        let mut webp = Cursor::new(Vec::new());

        // The WebP encoder is lossless and accepts only Rgb8/Rgba8, but PDFium
        // reports Luma8 for grayscale bitmaps, so normalize before encoding.
        DynamicImage::ImageRgba8(image.into_rgba8())
            .write_to(&mut webp, ImageFormat::WebP)
            .map_err(|error| format!("could not encode page {page_number} thumbnail: {error}"))?;

        Ok(webp.into_inner())
    }

    fn extract_text(&self, document_id: u64, page_number: i32) -> Result<Vec<PdfTextSpan>, String> {
        let documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let document = &documents
            .get(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?
            .document;

        if page_number < 1 || page_number > document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let unrotated_height = unrotated_page_height(&page);
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
                top: unrotated_height - top,
                width,
                height,
            });
        }

        Ok(spans)
    }

    /// Covers `quads` on `page_number` with one highlight annotation — one mark
    /// as far as the reader is concerned, so taking it back is one step.
    fn add_highlight(
        &self,
        document_id: u64,
        page_number: i32,
        quads: &[PagePointsRect],
        color: &str,
        opacity: f32,
    ) -> Result<(), String> {
        if quads.is_empty() {
            return Err("a highlight needs at least one quad".into());
        }

        if quads.len() > MAX_HIGHLIGHT_QUADS {
            return Err(format!(
                "a highlight may cover at most {MAX_HIGHLIGHT_QUADS} runs of text"
            ));
        }

        let color = annotation_color(color, opacity)?;
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        if page_number < 1 || page_number > entry.document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let unrotated_height = unrotated_page_height(&page);
        let rects = quads
            .iter()
            .map(|quad| page_rect_to_pdfium(quad, unrotated_height))
            .collect::<Vec<_>>();
        // PDFium draws a markup annotation from its quad points, but readers
        // expect `/Rect` to enclose them, so it is set from the run as a whole.
        let bounds = union_rect(&rects).ok_or_else(|| "highlight has no area".to_string())?;

        // Attached the moment it is created, before it has a shape or colour, so
        // a failure past here has to take it back off rather than return and
        // leave the page holding a mark nothing can remove.
        let mut annotation = page
            .annotations_mut()
            .create_highlight_annotation()
            .map_err(|error| format!("PDFium could not create a highlight: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(bounds)
                .map_err(|error| format!("PDFium rejected the highlight's bounds: {error}"))?;
            // `set_stroke_color` however much a highlight is a fill: the names
            // are `pdfium-render`'s and map onto a PDF annotation's two colour
            // entries — stroke to `/C`, fill to `/IC`. A highlight draws from
            // `/C`; `/IC` is a square's interior, and setting it here is
            // accepted, stored, then ignored at render time — indistinguishable
            // from a highlight that silently did not happen.
            annotation
                .set_stroke_color(color)
                .map_err(|error| format!("PDFium rejected the highlight's colour: {error}"))?;

            for rect in &rects {
                annotation
                    .attachment_points_mut()
                    .create_attachment_point_at_end(quad_points_from_rect(rect))
                    .map_err(|error| format!("PDFium rejected a highlight quad: {error}"))?;
            }

            Ok(())
        })();

        if let Err(error) = described {
            let annotations = page.annotations_mut();
            let count = annotations.len();

            if count > 0 {
                if let Ok(orphan) = annotations.get(count - 1) {
                    let _ = annotations.delete_annotation(orphan);
                }
            }

            return Err(error);
        }

        *entry.added.entry(page_number).or_insert(0) += 1;

        Ok(())
    }

    /// Removes the annotation most recently added to `page_number`, refusing
    /// anything this session did not put there.
    ///
    /// Checked here rather than trusted from the caller, which is a browser and
    /// can always be wrong: deleting one of the document's own annotations would
    /// be silent, permanent, and saved into the reader's file.
    fn delete_last_annotation(&self, document_id: u64, page_number: i32) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        if page_number < 1 || page_number > entry.document.pages().len() {
            return Err(format!("page {page_number} does not exist"));
        }

        if entry.added.get(&page_number).copied().unwrap_or(0) == 0 {
            return Err(format!(
                "page {page_number} has no annotation of this session's to remove"
            ));
        }

        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let annotations = page.annotations_mut();
        let count = annotations.len();

        if count == 0 {
            return Err(format!("page {page_number} has no annotation to remove"));
        }

        let annotation = annotations
            .get(count - 1)
            .map_err(|error| format!("PDFium could not load the annotation: {error}"))?;

        annotations
            .delete_annotation(annotation)
            .map_err(|error| format!("PDFium could not remove the annotation: {error}"))?;

        if let Some(added) = entry.added.get_mut(&page_number) {
            *added -= 1;
        }

        Ok(())
    }

    /// Writes the document, annotations and all, to `path`.
    ///
    /// Through a temporary file in the destination's own directory, then a
    /// rename: a save interrupted half-written would otherwise leave the reader
    /// with neither the document they had nor the one they asked for. Same
    /// directory keeps the rename on one filesystem, where it is atomic.
    fn save_to(&self, document_id: u64, path: &Path) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;
        // A bare name has `""` for a parent, which would put the temporary file
        // in whatever directory the process started from — losing the atomic
        // rename, which needs one filesystem.
        let directory = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => return Err(format!("{} is not a usable destination", path.display())),
        };
        // Random, and created only if absent: a name someone can guess, in a
        // directory anyone can write to, could be waiting as a symlink, and the
        // document would be written through to whatever it points at. Random
        // rather than a counter, which would restart at 1 every launch — a
        // temporary file a crash left behind would then collide with, and
        // permanently block, every later save of the same document.
        let suffix = getrandom::u64()
            .map_err(|error| format!("could not name a temporary file: {error}"))?;
        let temporary = directory.join(format!(
            ".{}.{suffix:016x}.tfolio-save",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("document.pdf"),
        ));

        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("could not write beside {}: {error}", path.display()))?;

        // Written through the handle `create_new` just proved was ours, never by
        // handing the name back to be opened a second time: in that gap the file
        // could be swapped for a symlink, and PDFium's own `save_to_file` opens
        // by path.
        let saved = entry
            .document
            .save_to_writer(&mut file)
            .map_err(|error| format!("PDFium could not write the document: {error}"));

        drop(file);

        let written = saved.and_then(|()| {
            fs::rename(&temporary, path)
                .map_err(|error| format!("could not write to {}: {error}", path.display()))
        });

        if written.is_err() {
            // Hidden, so one left behind is one the reader would never find.
            let _ = fs::remove_file(&temporary);
        }

        written
    }

    fn close(&self, document_id: u64) -> Result<(), String> {
        self.documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?
            .remove(&document_id);

        Ok(())
    }
}

/// The page's intrinsic clockwise `/Rotate` in degrees (0/90/180/270), or 0 if
/// PDFium cannot report it.
fn page_rotation_degrees(page: &PdfPage<'_>) -> f32 {
    page.rotation()
        .map(|rotation| rotation.as_degrees())
        .unwrap_or(0.0)
}

/// A page's height in its own *unrotated* coordinate space.
///
/// `height()` is the displayed height, `/Rotate` already applied, so a 90°/270°
/// page's unrotated height is its displayed *width*. Every flip between PDFium's
/// bottom-left origin and the frontend's top-left goes through this, so the two
/// directions cannot disagree about which edge the y-axis starts at.
fn unrotated_page_height(page: &PdfPage<'_>) -> f32 {
    let rotation = page_rotation_degrees(page);

    if rotation == 90.0 || rotation == 270.0 {
        page.width().value
    } else {
        page.height().value
    }
}

/// The exact inverse of the flip `extract_text` applies on the way out.
fn page_rect_to_pdfium(rect: &PagePointsRect, unrotated_height: f32) -> PdfRect {
    PdfRect::new_from_values(
        unrotated_height - (rect.top + rect.height),
        rect.left,
        unrotated_height - rect.top,
        rect.left + rect.width,
    )
}

/// Opacity rides the alpha channel, which is where PDFium reads an annotation's
/// transparency from.
fn annotation_color(hex: &str, opacity: f32) -> Result<PdfColor, String> {
    let color = PdfColor::from_hex(hex)
        .map_err(|error| format!("{hex} is not a usable annotation colour: {error}"))?;

    Ok(color.with_alpha((opacity.clamp(0.0, 1.0) * 255.0).round() as u8))
}

/// The four quad points a text markup annotation is drawn from.
///
/// Hand-built rather than `PdfQuadPoints::from_rect`, which winds the corners
/// anticlockwise from the bottom left. PDF orders them by *position* — top-left,
/// top-right, bottom-left, bottom-right — and PDFium reads the third pair's x as
/// the left edge and the second pair's as the right. Fed the anticlockwise
/// winding it takes both from the right-hand corners, so left equals right and
/// the highlight is a rectangle of zero width: stored, saved, reported by every
/// accessor, never drawn.
fn quad_points_from_rect(rect: &PdfRect) -> PdfQuadPoints {
    PdfQuadPoints::new(
        rect.left(),
        rect.top(),
        rect.right(),
        rect.top(),
        rect.left(),
        rect.bottom(),
        rect.right(),
        rect.bottom(),
    )
}

/// The smallest rectangle covering every one of `rects`, or `None` if empty.
fn union_rect(rects: &[PdfRect]) -> Option<PdfRect> {
    rects.iter().copied().reduce(|union, rect| {
        PdfRect::new(
            union.bottom().min(rect.bottom()),
            union.left().min(rect.left()),
            union.top().max(rect.top()),
            union.right().max(rect.right()),
        )
    })
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
pub async fn render_pdf_page_thumbnail(
    document_id: u64,
    page_number: i32,
    width: i32,
    state: State<'_, PdfiumState>,
) -> Result<Response, String> {
    let engine = Arc::clone(&state.0);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        engine.render_thumbnail(document_id, page_number, width)
    })
    .await
    .map_err(|error| format!("PDFium thumbnail task failed: {error}"))??;

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
pub async fn add_pdf_highlight_annotation(
    document_id: u64,
    page_number: i32,
    quads: Vec<PagePointsRect>,
    color: String,
    opacity: f32,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_highlight(document_id, page_number, &quads, &color, opacity)
    })
    .await
    .map_err(|error| format!("PDFium highlight task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_last_pdf_annotation(
    document_id: u64,
    page_number: i32,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.delete_last_annotation(document_id, page_number)
    })
    .await
    .map_err(|error| format!("PDFium annotation removal task failed: {error}"))?
}

#[tauri::command]
pub async fn export_pdf(
    document_id: u64,
    path: String,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.save_to(document_id, Path::new(&path)))
        .await
        .map_err(|error| format!("PDFium save task failed: {error}"))?
}

#[tauri::command]
pub fn close_pdf(document_id: u64, state: State<'_, PdfiumState>) -> Result<(), String> {
    state.0.close(document_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises `objects` into a PDF. Shared by the fixtures below, which
    /// differ only in the objects they describe.
    fn build_pdf(objects: &[String]) -> Vec<u8> {
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

    // A portrait 200x300 page with `/Rotate 90` and the text "Hi" drawn at an
    // unrotated baseline of (50, 250).
    fn rotated_text_pdf() -> Vec<u8> {
        let content = "BT\n/F1 24 Tf\n50 250 Td\n(Hi) Tj\nET\n";
        let contents_obj = format!(
            "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            content.len()
        );
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
            "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
        ];
        build_pdf(&objects)
    }

    // PDFium can only be bound once per process, so share a single leaked
    // instance across the (otherwise independent) test engines.
    fn test_pdfium() -> &'static Pdfium {
        static PDFIUM: std::sync::OnceLock<&'static Pdfium> = std::sync::OnceLock::new();

        PDFIUM.get_or_init(|| {
            let library_path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pdfium")
                .join(PDFIUM_LIBRARY_NAME);
            let bindings = Pdfium::bind_to_library(&library_path).unwrap_or_else(|error| {
                panic!("could not load {}: {error}", library_path.display())
            });

            Box::leak(Box::new(Pdfium::new(bindings)))
        })
    }

    /// The one engine every test shares, mirroring the app's single
    /// `PdfiumState`.
    ///
    /// An engine each would be a lock each (see `PdfiumEngine::documents`), and
    /// the harness runs tests in parallel — which corrupts the heap.
    fn test_engine() -> &'static PdfiumEngine {
        static ENGINE: std::sync::OnceLock<PdfiumEngine> = std::sync::OnceLock::new();

        ENGINE.get_or_init(|| PdfiumEngine {
            pdfium: test_pdfium(),
            documents: Mutex::new(HashMap::new()),
            next_document_id: AtomicU64::new(1),
        })
    }

    /// Hands `inspect` a page with the store locked, which is the only way a test
    /// may look at one: loading and dropping a page is PDFium work like any
    /// other. The page drops before the guard, so nothing reaches PDFium
    /// unlocked.
    fn with_page<T>(
        engine: &PdfiumEngine,
        document_id: u64,
        page_number: i32,
        inspect: impl FnOnce(&PdfPage<'_>) -> T,
    ) -> T {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let page = documents[&document_id]
            .document
            .pages()
            .get(page_number - 1)
            .expect("the document should have the page");

        inspect(&page)
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn extracts_text_in_unrotated_space_for_rotated_page() {
        let engine = test_engine();
        let document = engine
            .open(rotated_text_pdf())
            .expect("PDFium should open the rotated PDF");

        // `/Rotate 90` is surfaced so the frontend can orient the text layer.
        assert_eq!(document.pages[0].rotation, 90.0);

        let spans = engine
            .extract_text(document.id, 1)
            .expect("PDFium should extract text");
        assert_eq!(spans.len(), 1, "the page has a single text run");

        let span = &spans[0];
        assert_eq!(span.text, "Hi");
        // Bounds stay in the unrotated 200x300 page space with a top-left
        // origin: the run sits near x=52, and the top-flip uses the unrotated
        // height (300), not the displayed height (200) — which would go negative.
        assert!((50.0..55.0).contains(&span.left), "left was {}", span.left);
        assert!((30.0..36.0).contains(&span.top), "top was {}", span.top);
        assert!(span.width > 0.0 && span.top > 0.0);
    }

    fn minimal_pdf() -> Vec<u8> {
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ];
        build_pdf(&objects)
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn opens_and_renders_pdf_with_pdfium() {
        let engine = test_engine();
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

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn renders_thumbnail_as_webp() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let webp = engine
            .render_thumbnail(document.id, 1, 200)
            .expect("PDFium should render the thumbnail");

        // RIFF container magic, with the four-byte file size in between.
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");

        // Thumbnails are capped well below the full-page render ceiling.
        let error = engine
            .render_thumbnail(document.id, 1, MAX_THUMBNAIL_WIDTH + 1)
            .expect_err("thumbnails wider than the cap are rejected");
        assert!(error.contains("render width must be between"));
    }

    fn quad(left: f32, top: f32, width: f32, height: f32) -> PagePointsRect {
        PagePointsRect {
            height,
            left,
            top,
            width,
        }
    }

    // Stands in for the links, form fields, and comments a real document
    // arrives with.
    fn link_pdf() -> Vec<u8> {
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [5 0 R] /Contents 4 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
            "5 0 obj\n<< /Type /Annot /Subtype /Link /Rect [10 250 90 270] /Border [0 0 0] >>\nendobj\n".to_string(),
        ];

        build_pdf(&objects)
    }

    // An upright 200x300 page with "Hello" drawn at a baseline of (50, 250), so
    // there is real ink for a highlight to sit over.
    fn text_pdf() -> Vec<u8> {
        let content = "BT\n/F1 24 Tf\n50 250 Td\n(Hello) Tj\nET\n";
        let contents_obj = format!(
            "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            content.len()
        );
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
            "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
        ];
        build_pdf(&objects)
    }

    /// A page point is two device pixels on the 200x300 fixtures at this width.
    const TEST_RENDER_WIDTH: i32 = 400;

    /// How much ink a render of `page_number` puts on the page, and where.
    ///
    /// Off the pixels rather than the annotation list: an annotation PDFium has
    /// stored but will not draw counts the same as one that works. Split by
    /// region rather than totalled: a highlight at the wrong end of the page
    /// puts down exactly as much ink as one at the right end.
    fn ink_inside_and_outside(
        engine: &PdfiumEngine,
        document_id: u64,
        page_number: i32,
        band: (u32, u32, u32, u32),
    ) -> (u64, u64) {
        let image = engine
            .render_bitmap(
                document_id,
                page_number,
                TEST_RENDER_WIDTH,
                MAX_RENDER_WIDTH,
            )
            .expect("PDFium should render the page")
            .into_rgb8();
        let (left, top, right, bottom) = band;
        let mut inside = 0;
        let mut outside = 0;

        for (x, y, pixel) in image.enumerate_pixels() {
            let [red, green, blue] = pixel.0;
            let ink = (255 - red) as u64 + (255 - green) as u64 + (255 - blue) as u64;

            if x >= left && x < right && y >= top && y < bottom {
                inside += ink;
            } else {
                outside += ink;
            }
        }

        (inside, outside)
    }

    fn rendered_darkness(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> u64 {
        let (inside, outside) =
            ink_inside_and_outside(engine, document_id, page_number, (0, 0, 0, 0));

        inside + outside
    }

    // A highlight has to actually be drawn, not merely recorded. PDFium keeps an
    // annotation's colour in one of two entries and only draws a highlight from
    // one of them, so this is what tells the two apart.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn draws_a_highlight_where_it_was_asked_for() {
        let engine = test_engine();
        let document = engine.open(text_pdf()).expect("PDFium should open the PDF");
        // The quad (45,40)-(155,70) at two pixels per point.
        let band = (90, 80, 310, 140);
        let (inside_before, outside_before) = ink_inside_and_outside(engine, document.id, 1, band);

        engine
            .add_highlight(
                document.id,
                1,
                &[quad(45.0, 40.0, 110.0, 30.0)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");

        let (inside_after, outside_after) = ink_inside_and_outside(engine, document.id, 1, band);

        assert!(
            inside_after > inside_before,
            "the highlight put no ink where it was asked for: {inside_before} -> {inside_after}"
        );
        assert_eq!(
            outside_after, outside_before,
            "the highlight put ink outside the run it was asked to cover"
        );

        engine
            .delete_last_annotation(document.id, 1)
            .expect("PDFium should remove the highlight");
        assert_eq!(
            ink_inside_and_outside(engine, document.id, 1, band),
            (inside_before, outside_before),
            "removing the highlight should leave the page as it was"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn writes_a_highlight_that_survives_a_save() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_highlight(
                document.id,
                1,
                &[quad(10.0, 20.0, 80.0, 12.0)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");

        let directory = std::env::temp_dir().join(format!("tfolio-save-{}", document.id));
        fs::create_dir_all(&directory).expect("the test needs a directory to save into");

        let path = directory.join("highlighted.pdf");
        engine
            .save_to(document.id, &path)
            .expect("PDFium should save the document");

        let saved = fs::read(&path).expect("the saved document should be readable");
        let reopened = engine
            .open(saved)
            .expect("PDFium should reopen the saved document");

        assert_eq!(
            with_page(engine, reopened.id, 1, |page| page.annotations().len()),
            1,
            "the highlight should have been written to the file"
        );
        // The fixture page is blank, so any ink is the highlight — which also
        // proves its appearance survived the round trip through the file.
        assert!(
            rendered_darkness(engine, reopened.id, 1) > 0,
            "the reopened highlight put no ink on the page"
        );

        fs::remove_dir_all(&directory).ok();
    }

    // The temporary file is the save's own business, and it is hidden, so one
    // left behind is one the reader would never find and never clear. Saving
    // twice over the same name is where a temporary that outlives its save, or a
    // name that repeats itself, would show up.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn leaves_nothing_beside_a_saved_document() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        let directory = std::env::temp_dir().join(format!("tfolio-save-{}", document.id));
        fs::create_dir_all(&directory).expect("the test needs a directory to save into");

        let path = directory.join("saved.pdf");

        for attempt in 1..=2 {
            engine
                .save_to(document.id, &path)
                .unwrap_or_else(|error| panic!("save {attempt} should have succeeded: {error}"));
        }

        let left: Vec<_> = fs::read_dir(&directory)
            .expect("the destination directory should be readable")
            .map(|entry| entry.expect("the entry should be readable").path())
            .collect();

        assert_eq!(
            left,
            vec![path],
            "a save should leave the document and nothing else"
        );

        fs::remove_dir_all(&directory).ok();
    }

    // A page's `/Rotate` decides which edge the y-axis flips against, so this is
    // where a wrong flip shows up.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn places_a_highlight_in_unrotated_space_for_a_rotated_page() {
        let engine = test_engine();
        let document = engine
            .open(rotated_text_pdf())
            .expect("PDFium should open the rotated PDF");
        let spans = engine
            .extract_text(document.id, 1)
            .expect("PDFium should extract text");
        let span = &spans[0];

        engine
            .add_highlight(
                document.id,
                1,
                &[quad(span.left, span.top, span.width, span.height)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");

        let bounds = with_page(engine, document.id, 1, |page| {
            page.annotations()
                .get(0)
                .expect("the highlight should exist")
                .bounds()
                .expect("the highlight should have bounds")
        });

        // Against the page's own unrotated height, not against `span.top`: both
        // directions of the flip go through `unrotated_page_height`, so a test
        // that only checked the highlight landed back where the span said would
        // pass with the flip broken in both, each error cancelling the other.
        assert!(
            (bounds.top().value - (300.0 - span.top)).abs() < 0.5,
            "a run {}pt down a 300pt page should sit {}pt up, not {}",
            span.top,
            300.0 - span.top,
            bounds.top().value
        );
        assert!(
            (bounds.left().value - span.left).abs() < 0.5,
            "left was {}, expected {}",
            bounds.left().value,
            span.left
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn deletes_only_the_most_recent_annotation() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        for top in [20.0, 60.0] {
            engine
                .add_highlight(
                    document.id,
                    1,
                    &[quad(10.0, top, 80.0, 12.0)],
                    "#ffd54a",
                    0.4,
                )
                .expect("PDFium should create the highlight");
        }

        engine
            .delete_last_annotation(document.id, 1)
            .expect("PDFium should remove the annotation");

        let (remaining, bounds) = with_page(engine, document.id, 1, |page| {
            (
                page.annotations().len(),
                page.annotations()
                    .get(0)
                    .expect("the first highlight should remain")
                    .bounds()
                    .expect("the highlight should have bounds"),
            )
        });

        assert_eq!(remaining, 1, "only one should have gone");
        // The one left is the one drawn first, so undo took back the later mark.
        assert!(
            (265.0..=282.0).contains(&bounds.top().value),
            "the surviving highlight was at {}",
            bounds.top().value
        );

        engine
            .delete_last_annotation(document.id, 1)
            .expect("PDFium should remove the remaining annotation");

        let error = engine
            .delete_last_annotation(document.id, 1)
            .expect_err("a page with nothing on it has nothing to undo");
        assert!(error.contains("no annotation of this session's"));
    }

    // The guard between a frontend that has lost count and the reader's own
    // document.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn refuses_to_remove_an_annotation_it_did_not_add() {
        let engine = test_engine();
        let document = engine.open(link_pdf()).expect("PDFium should open the PDF");

        // The document arrives with one annotation of its own.
        assert_eq!(
            with_page(engine, document.id, 1, |page| page.annotations().len()),
            1
        );

        let error = engine
            .delete_last_annotation(document.id, 1)
            .expect_err("nothing of this session's is on the page yet");
        assert!(error.contains("no annotation of this session's"));

        engine
            .add_highlight(
                document.id,
                1,
                &[quad(10.0, 20.0, 80.0, 12.0)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");
        engine
            .delete_last_annotation(document.id, 1)
            .expect("the session's own highlight comes back off");

        // Once its own mark is gone it stops, rather than taking the document's.
        let error = engine
            .delete_last_annotation(document.id, 1)
            .expect_err("the document's own annotation is not the session's to remove");
        assert!(error.contains("no annotation of this session's"));
        assert_eq!(
            with_page(engine, document.id, 1, |page| page.annotations().len()),
            1,
            "the document's own annotation should still be there"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn rejects_an_unusable_highlight() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        let error = engine
            .add_highlight(document.id, 1, &[], "#ffd54a", 0.4)
            .expect_err("a highlight covering nothing is not a highlight");
        assert!(error.contains("at least one quad"));

        let error = engine
            .add_highlight(
                document.id,
                1,
                &[quad(0.0, 0.0, 10.0, 10.0)],
                "not-a-colour",
                0.4,
            )
            .expect_err("a colour PDFium cannot read is rejected");
        assert!(error.contains("not a usable annotation colour"));

        let error = engine
            .add_highlight(
                document.id,
                9,
                &[quad(0.0, 0.0, 10.0, 10.0)],
                "#ffd54a",
                0.4,
            )
            .expect_err("a page that does not exist is rejected");
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn builds_a_union_covering_every_rect() {
        let union = union_rect(&[
            PdfRect::new_from_values(10.0, 20.0, 30.0, 40.0),
            PdfRect::new_from_values(5.0, 50.0, 25.0, 90.0),
        ])
        .expect("two rects have a union");

        assert_eq!(union.bottom().value, 5.0);
        assert_eq!(union.left().value, 20.0);
        assert_eq!(union.top().value, 30.0);
        assert_eq!(union.right().value, 90.0);
        assert!(union_rect(&[]).is_none());
    }

    #[test]
    fn flips_a_rect_onto_pdfium_s_own_axes() {
        let rect = page_rect_to_pdfium(&quad(10.0, 20.0, 80.0, 12.0), 300.0);

        assert_eq!(rect.left().value, 10.0);
        assert_eq!(rect.right().value, 90.0);
        // 20pt down from the top of a 300pt page is 280pt up from its bottom.
        assert_eq!(rect.top().value, 280.0);
        assert_eq!(rect.bottom().value, 268.0);
    }

    #[test]
    fn carries_opacity_on_the_colour_s_alpha() {
        let color = annotation_color("#ffd54a", 0.4).expect("a hex colour is usable");

        assert_eq!(color.red(), 255);
        assert_eq!(color.green(), 213);
        assert_eq!(color.blue(), 74);
        assert_eq!(color.alpha(), 102);

        // Held to the ends rather than wrapping around the byte.
        assert_eq!(
            annotation_color("#ffd54a", 2.0)
                .expect("a hex colour is usable")
                .alpha(),
            255
        );
        assert!(annotation_color("nope", 0.4).is_err());
    }
}
