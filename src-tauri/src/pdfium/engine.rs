use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use image::{DynamicImage, ImageFormat};
use pdfium_render::prelude::*;
use tauri::AppHandle;

use super::{
    font::{cjk_font_path, needs_embedded_font, standard_face, subset_for, StandardFace},
    geometry::{
        annotation_color, clamp_corner_radius, page_rect_to_pdfium, page_rotation_degrees,
        quad_points_from_rect, rect_path, union_rect, unrotated_page_height, within_page_range,
        RectPathSegment, MAX_RECT_CORNER_RADIUS, MAX_RECT_STROKE_WIDTH, MAX_TEXT_NOTE_CHARS,
        MAX_TEXT_NOTE_FONT_SIZE, MAX_TEXT_NOTE_LINES, MIN_RECT_OPACITY, MIN_RECT_STROKE_WIDTH,
        MIN_TEXT_NOTE_FONT_SIZE, MIN_TEXT_NOTE_OPACITY, TEXT_NOTE_BOUNDS_MARGIN,
        TEXT_NOTE_LINE_HEIGHT,
    },
    library::bind_pdfium,
    size_limit_error, ExportOutcome, PagePoint, PagePointsRect, PdfDocumentInfo, PdfOutlineItem,
    PdfPageInfo, PdfTextSpan, RectStyle, TextNoteStyle, MAX_PDF_BYTES,
};

const MIN_RENDER_WIDTH: i32 = 64;
const MAX_RENDER_WIDTH: i32 = 4096;
const MAX_RENDER_HEIGHT: i32 = 4096;
// Thumbnails are decorative navigation targets, never read at full size, so they
// get a much tighter ceiling than a full page render.
const MAX_THUMBNAIL_WIDTH: i32 = 512;
// Each quad is a PDFium call made under the lock every render waits on, and no
// page has this many runs of text.
const MAX_HIGHLIGHT_QUADS: usize = 8192;

struct OpenDocument {
    document: PdfDocument<'static>,
    /// How many annotations this session has added to each page.
    ///
    /// PDFium appends, so the reader's own marks are the tail of a page's
    /// annotations and this is how long that tail is. Past it lie the document's
    /// own — links, form fields, comments — which an undo must never reach.
    added: HashMap<i32, u32>,
    /// The file this document was opened from, and so the file a save writes
    /// back over. `None` — opened from bytes — leaves nothing to overwrite,
    /// and a first export adopts its destination as the source.
    source_path: Option<PathBuf>,
    /// Whether this session has deleted an annotation. Deleting one takes the
    /// annotation but not what it referenced — an embedded font subset, its
    /// appearance's objects — and PDFium writes those out with everything else,
    /// so the first save after a deletion routes through a reload to collect
    /// them (measured: five undo/redo rounds of a Chinese note save at 21 KB
    /// straight, 4 KB collected).
    removed_any: bool,
}

pub(super) struct PdfiumEngine {
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
    /// Where the bundled CJK font is, resolved at startup because that is the
    /// only point an `AppHandle` reaches this module.
    cjk_font_path: Option<PathBuf>,
    /// The font itself, read on the first note that needs it. ~17 MB that most
    /// sessions never touch, so it is not read at startup — and once read it is
    /// kept, because every CJK note subsets it again.
    cjk_font: OnceLock<Vec<u8>>,
    /// Paths something outside the WebView produced — a drop the window saw, a
    /// pick a dialog returned. `open_pdf_from_path` acts only on these: a path
    /// is a string any page code can make up, and opening one binds it as the
    /// file a save will later overwrite. Grows only by the reader's own
    /// gestures, so it is never cleared.
    approved_paths: Mutex<HashSet<PathBuf>>,
}

#[derive(Clone)]
pub struct PdfiumState(pub(super) Arc<PdfiumEngine>);

impl PdfiumState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let bindings = bind_pdfium(app)?;
        let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));

        Ok(Self(Arc::new(PdfiumEngine {
            pdfium,
            documents: Mutex::new(HashMap::new()),
            next_document_id: AtomicU64::new(1),
            // Absent is not fatal here: it only fails the first note that needs
            // it, so a missing font cannot stop the app from opening PDFs.
            cjk_font_path: cjk_font_path(app),
            cjk_font: OnceLock::new(),
            approved_paths: Mutex::new(HashSet::new()),
        })))
    }

    /// Records paths the OS itself produced — the window's drag-drop handler
    /// calls this, from outside the `pdfium` module.
    pub fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        self.0.approve_paths(paths);
    }
}

impl PdfiumEngine {
    pub(super) fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        if let Ok(mut approved) = self.approved_paths.lock() {
            approved.extend(paths.into_iter().cloned());
        }
    }

    /// Whether something outside the WebView — a drop, a dialog — produced
    /// this path. Kept rather than consumed: the reader may cancel the unsaved
    /// guard and open the same file again.
    // The e2e build waives the check at its one call site, in `open_pdf_from_path`.
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    pub(super) fn is_approved(&self, path: &Path) -> bool {
        self.approved_paths
            .lock()
            .map(|approved| approved.contains(path))
            .unwrap_or(false)
    }

    pub(super) fn open(&self, bytes: Vec<u8>) -> Result<PdfDocumentInfo, String> {
        self.open_with_source(bytes, None)
    }

    /// Opens the file at `path`, remembering it as the place a save writes back
    /// to.
    pub(super) fn open_from_path(&self, path: PathBuf) -> Result<PdfDocumentInfo, String> {
        // Sized before it is read: `open_with_source` checks the byte count too,
        // but only after `fs::read` has already pulled an arbitrarily large file
        // into memory.
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("could not open {}: {error}", path.display()))?;

        if !metadata.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }

        if metadata.len() > MAX_PDF_BYTES as u64 {
            return Err(size_limit_error());
        }

        let bytes = fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;

        self.open_with_source(bytes, Some(path))
    }

    fn open_with_source(
        &self,
        bytes: Vec<u8>,
        source_path: Option<PathBuf>,
    ) -> Result<PdfDocumentInfo, String> {
        if bytes.is_empty() {
            return Err("PDF file is empty".into());
        }

        if bytes.len() > MAX_PDF_BYTES {
            return Err(size_limit_error());
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
        let path = source_path
            .as_deref()
            .map(|path| path.to_string_lossy().into_owned());

        documents.insert(
            id,
            OpenDocument {
                added: HashMap::new(),
                document,
                source_path,
                removed_any: false,
            },
        );

        Ok(PdfDocumentInfo {
            id,
            num_pages,
            pages,
            outline,
            path,
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

    pub(super) fn render_page(
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

    pub(super) fn render_thumbnail(
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

    pub(super) fn extract_text(
        &self,
        document_id: u64,
        page_number: i32,
    ) -> Result<Vec<PdfTextSpan>, String> {
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
    pub(super) fn add_highlight(
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
        // Fully transparent draws nothing yet still records as a mark; the UI
        // fixes opacity well above zero, but the command takes any value.
        if color.alpha() == 0 {
            return Err("a highlight needs a visible colour".into());
        }

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

    /// Draws a rectangle on `page_number` — one mark, so one step to take back.
    ///
    /// Carried by a Stamp annotation holding a hand-built path object, not a
    /// Square — including for a right-angled one, where the plan had wanted a
    /// Square. Both halves of a Square's shape come from `/Border`
    /// `[h_radius v_radius width]`, and PDFium honours only the width: rendering
    /// a Square with `[25 25 2]` puts down pixel-for-pixel the same corner as
    /// `[0 0 2]`, so a rounded Square would be accepted, stored, saved, and
    /// drawn with square corners. Nor is the width reachable: `pdfium-render`
    /// binds `FPDFAnnot_SetBorder` but keeps the annotation handle it needs
    /// `pub(crate)`, and a Square cannot own the page object whose ownership
    /// would hand one back, so the stroke-width slider would go nowhere.
    ///
    /// The cost is that other tools see a stamp rather than a native rectangle
    /// they could edit — acceptable while this app only creates and undoes.
    /// Drawing the path ourselves keeps every part of the style — border, fill,
    /// opacity, radius — a real, rendered thing the CSS preview matches.
    pub(super) fn add_rect(
        &self,
        document_id: u64,
        page_number: i32,
        bounds: &PagePointsRect,
        style: &RectStyle,
    ) -> Result<(), String> {
        // The WebView can call this with any arguments. Coordinates are held to a
        // range that covers any real page with room to spare; one outside it is
        // refused here rather than clamped, before it can slip past the `> 0`
        // check below or overflow a page edge to infinity.
        if ![bounds.left, bounds.top, bounds.width, bounds.height]
            .iter()
            .all(|value| within_page_range(*value))
        {
            return Err("a rectangle's coordinates are out of range".into());
        }

        // The style's sizes have the sliders' ranges (see annotationStyles.ts) as
        // their contract, enforced on both sides of the boundary: a value the
        // reader could never have chosen — a wider stroke, a larger radius, an
        // opacity past full — is refused rather than quietly clamped into a
        // different mark than they drew. `contains` also rejects a non-finite.
        if !(MIN_RECT_OPACITY..=1.0).contains(&style.opacity)
            || !(MIN_RECT_STROKE_WIDTH..=MAX_RECT_STROKE_WIDTH).contains(&style.stroke_width)
            || !(0.0..=MAX_RECT_CORNER_RADIUS).contains(&style.corner_radius)
        {
            return Err("a rectangle's style values are out of range".into());
        }

        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err("a rectangle needs a positive width and height".into());
        }

        // Drawn at the width the reader chose and the preview showed, not
        // shrunk to the shape: the range check above already held it to the
        // sliders' bounds, so there is nothing left to clamp, and clamping here
        // would silently redraw a thin rectangle's border narrower than drawn.
        let stroke = match &style.stroke_color {
            Some(hex) => Some((annotation_color(hex, style.opacity)?, style.stroke_width)),
            None => None,
        };
        let fill = match &style.fill_color {
            Some(hex) => Some(annotation_color(hex, style.opacity)?),
            None => None,
        };

        // Visible means a pixel that actually lands: a colour that is present
        // *and* not fully transparent. No colour, or zero opacity, draws nothing
        // — accepted, stored, saved, invisible, yet still recorded as an edit,
        // which is the failure this project measures pixels to catch.
        let draws_border = stroke.as_ref().is_some_and(|(color, _)| color.alpha() > 0);
        let draws_fill = fill.as_ref().is_some_and(|color| color.alpha() > 0);
        if !draws_border && !draws_fill {
            return Err("a rectangle needs a visible border or fill".into());
        }

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

        // Loaded only to read its unrotated height, then dropped: the path is
        // built against `&entry.document`, which cannot be borrowed while a page
        // is out of it.
        let unrotated_height = {
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            unrotated_page_height(&page)
        };
        let rect = page_rect_to_pdfium(bounds, unrotated_height);
        // A stroke is centred on the path it follows, and PDFium clips a stamp's
        // appearance to the annotation's `/Rect` — so a path traced along the
        // bounds loses the outer half of its border, rendering a 12pt one 6pt
        // wide. Tracing it half a stroke inside puts the whole width within the
        // bounds, which is also where the preview draws it: CSS `border-box`
        // puts a border inside the element's box, not straddling its edge.
        //
        // A rectangle narrower than its own border insets to nothing; the stroke
        // centred on that still covers the bounds, which is the right picture.
        let inset = match &stroke {
            Some((_, width)) => (width / 2.0).min(bounds.width.min(bounds.height) / 2.0),
            None => 0.0,
        };
        let path_rect = PdfRect::new_from_values(
            rect.bottom().value + inset,
            rect.left().value + inset,
            rect.top().value - inset,
            rect.right().value - inset,
        );
        // `corner_radius` is the outer corner, as the preview's `border-radius`
        // is, so the path's own radius is that less the distance it moved in.
        let radius = clamp_corner_radius(
            bounds.width - inset * 2.0,
            bounds.height - inset * 2.0,
            style.corner_radius - inset,
        );
        let plan = rect_path(&path_rect, radius);

        let (stroke_color, stroke_width) = match &stroke {
            Some((color, width)) => (Some(*color), Some(PdfPoints::new(*width))),
            None => (None, None),
        };

        // A free object until it is added below, so a failure while it is being
        // drawn has nothing to take off the page.
        let mut path = PdfPagePathObject::new(
            &entry.document,
            PdfPoints::new(plan.start.0),
            PdfPoints::new(plan.start.1),
            stroke_color,
            stroke_width,
            fill,
        )
        .map_err(|error| format!("PDFium could not start the rectangle: {error}"))?;

        for segment in &plan.segments {
            match *segment {
                RectPathSegment::LineTo { x, y } => path
                    .line_to(PdfPoints::new(x), PdfPoints::new(y))
                    .map_err(|error| format!("PDFium rejected a rectangle edge: {error}"))?,
                RectPathSegment::BezierTo {
                    x,
                    y,
                    c1x,
                    c1y,
                    c2x,
                    c2y,
                } => path
                    .bezier_to(
                        PdfPoints::new(x),
                        PdfPoints::new(y),
                        PdfPoints::new(c1x),
                        PdfPoints::new(c1y),
                        PdfPoints::new(c2x),
                        PdfPoints::new(c2y),
                    )
                    .map_err(|error| format!("PDFium rejected a rectangle corner: {error}"))?,
            }
        }
        path.close_path()
            .map_err(|error| format!("PDFium could not close the rectangle: {error}"))?;

        // Attached the moment it is created, so a failure past here has to take
        // it back off rather than leave a mark nothing can remove.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a rectangle: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(rect)
                .map_err(|error| format!("PDFium rejected the rectangle's bounds: {error}"))?;
            annotation
                .objects_mut()
                .add_path_object(path)
                .map_err(|error| format!("PDFium rejected the rectangle's path: {error}"))?;
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

    /// The bundled CJK font's bytes, read once and kept.
    fn cjk_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.cjk_font.get() {
            return Ok(bytes);
        }

        let path = self.cjk_font_path.as_ref().ok_or_else(|| {
            "the bundled font is missing; run `bun run fonts:download`".to_string()
        })?;
        let bytes = fs::read(path)
            .map_err(|error| format!("the bundled font could not be read: {error}"))?;

        // Two notes can reach here at once and both read the file; whichever
        // stores first wins and the other's copy is dropped. Both then see the
        // same bytes, which is all that matters.
        let _ = self.cjk_font.set(bytes);

        self.cjk_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the bundled font could not be cached".to_string())
    }

    /// Writes `text` at `origin` as a stamp annotation carrying one text object
    /// per line.
    ///
    /// A stamp rather than the FreeText the format has for exactly this, because
    /// PDFium generates a FreeText's appearance itself and 0.9.3 exposes neither
    /// a font size nor a face on one — a note would come out at whatever size
    /// PDFium chose, in a font that cannot draw Chinese. Drawing the text into a
    /// stamp puts both under this app's control, at the cost that other readers
    /// see a stamp rather than an editable note, which is the same trade the
    /// rectangle tool already makes.
    ///
    /// The text does not wrap. A note breaks where the reader pressed return and
    /// nowhere else: wrapping would mean measuring runs against a width this
    /// tool does not have, and a note is a margin scribble rather than a column
    /// of prose.
    pub(super) fn add_text_note(
        &self,
        document_id: u64,
        page_number: i32,
        origin: &PagePoint,
        text: &str,
        style: &TextNoteStyle,
    ) -> Result<(), String> {
        if !within_page_range(origin.left) || !within_page_range(origin.top) {
            return Err("a note's coordinates are out of range".into());
        }

        // As with a rectangle's style, a value outside the controls' own ranges
        // is refused rather than clamped: it is not one the reader could have
        // chosen, and clamping would draw a note in a size they never picked.
        if !(MIN_TEXT_NOTE_FONT_SIZE..=MAX_TEXT_NOTE_FONT_SIZE).contains(&style.font_size)
            || !(MIN_TEXT_NOTE_OPACITY..=1.0).contains(&style.opacity)
        {
            return Err("a note's style values are out of range".into());
        }

        // Resolved here rather than where the font is chosen below, so an
        // unknown family is refused before a ~17 MB face is read and subset —
        // and so it is refused for a Chinese note too, which never reaches the
        // standard fonts and so never used to be checked at all.
        let face = standard_face(&style.font_family)
            .ok_or_else(|| "a note's font family is not one this app offers".to_string())?;
        let color = annotation_color(&style.color, style.opacity)?;

        // Invisible is a failure, not a note: a fully transparent one would be
        // stored, saved, and recorded as an edit while drawing nothing.
        if color.alpha() == 0 {
            return Err("a note needs a visible colour".into());
        }

        // Blank is not a note either. Checked before the length ceiling so a
        // whitespace-only note fails as empty rather than as too long.
        if text.trim().is_empty() {
            return Err("a note needs some text".into());
        }

        if text.chars().count() > MAX_TEXT_NOTE_CHARS {
            return Err("a note is too long".into());
        }

        // `\r\n` and `\r` both count as one break, so a note pasted from another
        // platform does not gain a blank line between every line.
        let lines: Vec<&str> = text
            .split('\n')
            .map(|line| line.trim_end_matches('\r'))
            .collect();

        if lines.len() > MAX_TEXT_NOTE_LINES {
            return Err("a note has too many lines".into());
        }

        // Subset before the lock: reading and cutting down a ~17 MB font is the
        // slow part of this, and it needs no document, so renders should not
        // queue behind it.
        let embedded = if needs_embedded_font(text) {
            Some(subset_for(self.cjk_font_bytes()?, text)?)
        } else {
            None
        };

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

        let unrotated_height = {
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            unrotated_page_height(&page)
        };

        // A face the standard 14 cover costs no embedded bytes at all, which is
        // the common case for a Latin note; anything else carries its subset.
        let font = match &embedded {
            // Loaded afresh each time, so a redo of a note that was just undone
            // embeds its subset again: a font stays in the document once loaded,
            // and deleting the annotation that used it does not take it back
            // out. That costs roughly 3.4 KB per undo/redo cycle.
            //
            // Not cached, because keeping the token would need it to be `Send`,
            // and `pdfium-render` 0.9.3 marks every other handle so but not this
            // one — leaving only an `unsafe impl` to assert a lifetime the crate
            // never documents. Reloading a saved document drops the orphans
            // anyway (measured: 21034 bytes down to 4088), so collecting them
            // belongs to the save path rather than here.
            Some(bytes) => entry
                .document
                .fonts_mut()
                .load_true_type_from_bytes(bytes, true)
                .map_err(|error| format!("PDFium rejected the bundled font: {error}"))?,
            None => {
                let fonts = entry.document.fonts_mut();

                match face {
                    StandardFace::Sans => fonts.helvetica(),
                    StandardFace::Serif => fonts.times_roman(),
                    StandardFace::Mono => fonts.courier(),
                }
            }
        };

        let ascent = entry
            .document
            .fonts()
            .get(font)
            .ok_or_else(|| "PDFium lost the note's font".to_string())?
            .ascent(PdfPoints::new(style.font_size))
            .map_err(|error| format!("PDFium could not measure the note's font: {error}"))?
            .value;

        // Laid out before the annotation exists, because the annotation needs its
        // final `/Rect` up front: PDFium fits a stamp's appearance to whatever
        // `/Rect` it has, so bounds narrowed afterwards do not crop the text —
        // they squash it, and the whole note renders shrunk into the new box.
        //
        // Free objects until they are added below, so a failure while they are
        // being laid out has nothing to take off the page.
        let mut laid_out = Vec::new();
        let mut text_bounds: Option<PdfRect> = None;

        for (index, line) in lines.iter().enumerate() {
            // A blank line draws nothing but still advances the next one, which
            // is how an empty line between paragraphs survives.
            if line.is_empty() {
                continue;
            }

            let mut object = PdfPageTextObject::new(
                &entry.document,
                line,
                font,
                PdfPoints::new(style.font_size),
            )
            .map_err(|error| format!("PDFium rejected a line of the note: {error}"))?;

            object
                .set_fill_color(color)
                .map_err(|error| format!("PDFium rejected the note's colour: {error}"))?;

            // A new text object sits with its baseline on the origin, so moving
            // it is what puts it where the reader clicked.
            //
            // PDFium draws a line from its baseline, but a reader clicks where
            // they want the text to start, which is its top. The gap between the
            // two is the font's ascent — asked of the font rather than guessed
            // from the size, since the two differ by face and a wrong guess
            // lands the note a line away from the click.
            //
            // Lines then step by the baseline, not by what each one happens to
            // draw: spacing measured from the ink would pull a line with no
            // ascenders up towards the one above it.
            let baseline =
                origin.top + ascent + index as f32 * style.font_size * TEXT_NOTE_LINE_HEIGHT;

            object
                .translate(
                    PdfPoints::new(origin.left),
                    PdfPoints::new(unrotated_height - baseline),
                )
                .map_err(|error| format!("PDFium could not place the note: {error}"))?;

            let placed = object
                .bounds()
                .map_err(|error| format!("PDFium could not measure the note: {error}"))?;

            let line_bounds =
                PdfRect::new(placed.bottom(), placed.left(), placed.top(), placed.right());

            text_bounds = Some(match text_bounds {
                None => line_bounds,
                Some(so_far) => union_rect(&[so_far, line_bounds])
                    .expect("a union of two rectangles is never empty"),
            });
            laid_out.push(object);
        }

        // Every line was blank, so there is nothing to show — the same
        // invisible-but-recorded edit the colour check above refuses.
        let text_bounds = text_bounds.ok_or_else(|| "a note needs some text".to_string())?;
        // A hair wider than the ink on every side. The appearance is fitted to
        // this box, and glyphs that ended exactly on its edge would lose their
        // outermost antialiased pixel to it.
        let bounds = PdfRect::new_from_values(
            text_bounds.bottom().value - TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.left().value - TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.top().value + TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.right().value + TEXT_NOTE_BOUNDS_MARGIN,
        );

        // Attached the moment it is created, so a failure past here has to take
        // it back off rather than leave a mark nothing can remove.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a note: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(bounds)
                .map_err(|error| format!("PDFium rejected the note's bounds: {error}"))?;

            for object in laid_out {
                annotation
                    .objects_mut()
                    .add_text_object(object)
                    .map_err(|error| format!("PDFium rejected a line of the note: {error}"))?;
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
    pub(super) fn delete_last_annotation(
        &self,
        document_id: u64,
        page_number: i32,
    ) -> Result<(), String> {
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
        entry.removed_any = true;

        Ok(())
    }

    /// Writes the document back over the file it was opened from.
    pub(super) fn save(&self, document_id: u64) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;
        let path = entry.source_path.clone().ok_or_else(|| {
            "this document was opened from bytes, so there is no file to save over".to_string()
        })?;

        self.write_document(entry, &path)
    }

    /// Writes the document to `path`, and — for a document that had no source —
    /// adopts `path` as one, making a byte-opened document's export a true
    /// save-as. Reports whether the write landed on the source path, which is
    /// what tells the frontend whether the file now matches the history.
    pub(super) fn export_to(&self, document_id: u64, path: &Path) -> Result<ExportOutcome, String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        self.write_document(entry, path)?;

        // Compared verbatim rather than canonicalized: both paths came out of
        // the OS's own dialogs, and mistaking a symlinked twin for a stranger
        // only leaves the history dirty — the safe direction.
        let saved_to_source = match &entry.source_path {
            Some(source) => source.as_path() == path,
            None => {
                entry.source_path = Some(path.to_path_buf());
                true
            }
        };

        Ok(ExportOutcome {
            path: path.to_string_lossy().into_owned(),
            saved_to_source,
        })
    }

    /// Writes the document, annotations and all, to `path`. Test-only since the
    /// dialogs moved into the commands: the app's two exits are `save` and
    /// `export_to`, and this is the bare write they share.
    #[cfg(test)]
    pub(super) fn save_to(&self, document_id: u64, path: &Path) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?;
        let entry = documents
            .get_mut(&document_id)
            .ok_or_else(|| "PDF document is no longer open".to_string())?;

        self.write_document(entry, path)
    }

    /// Reloads the document off its own saved bytes when this session has
    /// deleted an annotation, dropping whatever the deleted ones left behind —
    /// PDFium collects unreferenced objects on a load, and only there.
    ///
    /// Costs a whole extra copy of the document in memory while it runs, which
    /// is why it waits for a deletion instead of riding every save. The `added`
    /// counts survive the swap: a page's annotation order is its `/Annots`
    /// order, which a save and reload preserve, so the session's marks are
    /// still the tail an undo may take back.
    fn collect_orphans(&self, entry: &mut OpenDocument) -> Result<(), String> {
        if !entry.removed_any {
            return Ok(());
        }

        let bytes = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;

        entry.document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reload the document: {error}"))?;
        entry.removed_any = false;

        Ok(())
    }

    /// The one write path under every save and export, so their files come out
    /// identical — collected of orphans, and landed whole.
    ///
    /// Through a temporary file in the destination's own directory, then a
    /// rename: a save interrupted half-written would otherwise leave the reader
    /// with neither the document they had nor the one they asked for. Same
    /// directory keeps the rename on one filesystem, where it is atomic. The
    /// replacement cannot keep everything about the original — its owner and
    /// its hard links are beyond an unprivileged process — but its mode is
    /// carried over, and a symlinked destination is resolved so the save lands
    /// in the file the link points at rather than replacing the link.
    fn write_document(&self, entry: &mut OpenDocument, path: &Path) -> Result<(), String> {
        self.collect_orphans(entry)?;

        // A fresh export has nothing to canonicalize; the given path is it.
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let path = path.as_path();
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
            bounded_file_name(
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("document.pdf")
            ),
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
            .map_err(|error| format!("PDFium could not write the document: {error}"))
            // The rename orders the replacement; only a flush makes it real. A
            // crash between an unsynced rename and the writeback would leave
            // the name pointing at a hollow file — exactly the loss the
            // temporary file exists to prevent.
            .and_then(|()| {
                file.sync_all()
                    .map_err(|error| format!("could not flush the document: {error}"))
            });

        drop(file);

        // The temporary was born with default permissions; the file it is about
        // to become may be tighter (a 0600 document must not come back 0644).
        // Best effort — a failure here still saves, with default permissions.
        if let Ok(metadata) = fs::metadata(path) {
            let _ = fs::set_permissions(&temporary, metadata.permissions());
        }

        let written = saved.and_then(|()| {
            fs::rename(&temporary, path)
                .map_err(|error| format!("could not write to {}: {error}", path.display()))
        });

        if written.is_err() {
            // Hidden, so one left behind is one the reader would never find.
            let _ = fs::remove_file(&temporary);
        } else if let Ok(handle) = fs::File::open(directory) {
            // The rename itself lives in the directory; flush that too, best
            // effort, so the replacement survives a crash.
            let _ = handle.sync_all();
        }

        written
    }

    pub(super) fn close(&self, document_id: u64) -> Result<(), String> {
        self.documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())?
            .remove(&document_id);

        Ok(())
    }
}

/// At most 200 bytes of `name`, cut on a character boundary: the temporary
/// file adds a dot, sixteen hex digits, and `.tfolio-save` around it, and the
/// whole thing has to stay under the 255-byte NAME_MAX of the usual
/// filesystems.
fn bounded_file_name(name: &str) -> &str {
    const BUDGET: usize = 200;

    if name.len() <= BUDGET {
        return name;
    }

    let mut end = BUDGET;

    while !name.is_char_boundary(end) {
        end -= 1;
    }

    &name[..end]
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::pdfium::library::PDFIUM_LIBRARY_NAME;

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
            // Straight from the source tree: the tests have no `AppHandle` to
            // resolve a bundled resource through.
            cjk_font_path: Some(crate::pdfium::font::bundled_cjk_font_path()),
            cjk_font: OnceLock::new(),
            approved_paths: Mutex::new(HashSet::new()),
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

    fn rect_style(
        stroke: Option<&str>,
        fill: Option<&str>,
        opacity: f32,
        corner_radius: f32,
        stroke_width: f32,
    ) -> RectStyle {
        RectStyle {
            stroke_color: stroke.map(str::to_string),
            fill_color: fill.map(str::to_string),
            opacity,
            corner_radius,
            stroke_width,
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

    /// The pixel box the page's ink actually occupies, or `None` for a blank
    /// page.
    ///
    /// Where `ink_inside_and_outside` asks "did anything land here", this asks
    /// "how big is what landed" — which is what tells text drawn at its proper
    /// size from the same text drawn shrunk, stretched, or squashed into a
    /// corner of the same box. Every one of those puts all its ink inside the
    /// band and none outside it.
    fn ink_bounds(
        engine: &PdfiumEngine,
        document_id: u64,
        page_number: i32,
    ) -> Option<(u32, u32, u32, u32)> {
        let image = engine
            .render_bitmap(
                document_id,
                page_number,
                TEST_RENDER_WIDTH,
                MAX_RENDER_WIDTH,
            )
            .expect("PDFium should render the page")
            .into_rgb8();
        let mut box_of: Option<(u32, u32, u32, u32)> = None;

        for (x, y, pixel) in image.enumerate_pixels() {
            let [red, green, blue] = pixel.0;

            // Anything off pure white counts, so a glyph's antialiased edge is
            // part of it rather than a threshold's judgement call.
            if red == 255 && green == 255 && blue == 255 {
                continue;
            }

            box_of = Some(match box_of {
                None => (x, y, x + 1, y + 1),
                Some((left, top, right, bottom)) => {
                    (left.min(x), top.min(y), right.max(x + 1), bottom.max(y + 1))
                }
            });
        }

        box_of
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

    // A rectangle, like a highlight, has to land where it was asked for and
    // nowhere else. Filled with no border so all its ink is inside its bounds,
    // which is what lets the band outside it stay exactly as it was.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn draws_a_square_where_it_was_asked_for() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        // The box (50,60)-(150,150) at two pixels per point.
        let band = (100, 120, 300, 300);
        let (inside_before, outside_before) = ink_inside_and_outside(engine, document.id, 1, band);

        engine
            .add_rect(
                document.id,
                1,
                &quad(50.0, 60.0, 100.0, 90.0),
                &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
            )
            .expect("PDFium should create the rectangle");

        let (inside_after, outside_after) = ink_inside_and_outside(engine, document.id, 1, band);

        assert!(
            inside_after > inside_before,
            "the rectangle put no ink where it was asked for: {inside_before} -> {inside_after}"
        );
        assert_eq!(
            outside_after, outside_before,
            "the rectangle put ink outside the bounds it was asked to fill"
        );

        engine
            .delete_last_annotation(document.id, 1)
            .expect("PDFium should remove the rectangle");
        assert_eq!(
            ink_inside_and_outside(engine, document.id, 1, band),
            (inside_before, outside_before),
            "removing the rectangle should leave the page as it was"
        );
    }

    // Counting the path's segments proves nothing about what renders — only the
    // pixels can say the corner was actually carved. A rounded corner leaves the
    // square of page at its very corner emptier than a right angle would.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn draws_a_rounded_rect() {
        let engine = test_engine();
        // The top-left 25pt corner of a box at (50,50)-(150,150): px (100,100)-(150,150).
        let corner = (100, 100, 150, 150);
        let bounds = quad(50.0, 50.0, 100.0, 100.0);

        let square = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        engine
            .add_rect(
                square.id,
                1,
                &bounds,
                &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
            )
            .expect("PDFium should create the square-cornered rectangle");
        let (square_corner, _) = ink_inside_and_outside(engine, square.id, 1, corner);

        let rounded = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        engine
            .add_rect(
                rounded.id,
                1,
                &bounds,
                &rect_style(None, Some("#ff3b30"), 1.0, 25.0, 2.0),
            )
            .expect("PDFium should create the rounded rectangle");
        let (rounded_corner, _) = ink_inside_and_outside(engine, rounded.id, 1, corner);

        assert!(
            rounded_corner < square_corner,
            "the corner was not rounded: rounded {rounded_corner} vs square {square_corner}"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn rejects_an_unusable_rectangle() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        let error = engine
            .add_rect(
                document.id,
                1,
                &quad(10.0, 10.0, 0.0, 40.0),
                &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
            )
            .expect_err("a rectangle with no area is not a rectangle");
        assert!(error.contains("positive width and height"));

        let error = engine
            .add_rect(
                document.id,
                1,
                &quad(f32::NAN, 10.0, 40.0, 40.0),
                &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
            )
            .expect_err("a non-finite coordinate is rejected before it reaches PDFium");
        assert!(error.contains("coordinates are out of range"));

        // A far-off but finite coordinate: refused before it can overflow a page edge.
        let error = engine
            .add_rect(
                document.id,
                1,
                &quad(3.0e38, 0.0, 3.0e38, 40.0),
                &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
            )
            .expect_err("bounds beyond the page range are rejected");
        assert!(error.contains("coordinates are out of range"));

        // Style values outside the sliders' ranges are refused, not clamped: a
        // stroke thinner than 1pt or past 12, a radius past 40, an opacity below the
        // floor or past full — none of them a value the reader could have chosen.
        for style in [
            rect_style(Some("#ff3b30"), None, 1.0, 0.0, 0.0),
            rect_style(Some("#ff3b30"), None, 1.0, 0.0, 13.0),
            rect_style(Some("#ff3b30"), None, 1.0, 41.0, 2.0),
            rect_style(Some("#ff3b30"), Some("#ffcc00"), 0.0, 0.0, 2.0),
            rect_style(Some("#ff3b30"), None, 2.0, 0.0, 2.0),
            rect_style(Some("#ff3b30"), None, f32::MAX, 0.0, 2.0),
        ] {
            let error = engine
                .add_rect(document.id, 1, &quad(10.0, 10.0, 40.0, 40.0), &style)
                .expect_err("a style value outside its range is rejected");
            assert!(
                error.contains("style values are out of range"),
                "wrong rejection: {error}"
            );
        }

        // Both a border and a fill left off: in range, but nothing to draw.
        let error = engine
            .add_rect(
                document.id,
                1,
                &quad(10.0, 10.0, 40.0, 40.0),
                &rect_style(None, None, 1.0, 0.0, 2.0),
            )
            .expect_err("a rectangle with neither a border nor a fill draws nothing");
        assert!(error.contains("visible border or fill"));

        let error = engine
            .add_rect(
                document.id,
                1,
                &quad(10.0, 10.0, 40.0, 40.0),
                &rect_style(Some("not-a-colour"), None, 1.0, 0.0, 2.0),
            )
            .expect_err("a colour PDFium cannot read is rejected");
        assert!(error.contains("not a usable annotation colour"));

        let error = engine
            .add_rect(
                document.id,
                9,
                &quad(10.0, 10.0, 40.0, 40.0),
                &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
            )
            .expect_err("a page that does not exist is rejected");
        assert!(error.contains("does not exist"));
    }

    // A rectangle's flip onto PDFium's axes runs through the same helpers a
    // highlight uses, and a `/Rotate` page is where a wrong one shows. Pinned to
    // hardcoded values, not read back through the flip that placed it.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn places_a_rectangle_in_unrotated_space_for_a_rotated_page() {
        let engine = test_engine();
        let document = engine
            .open(rotated_text_pdf())
            .expect("PDFium should open the rotated PDF");

        engine
            .add_rect(
                document.id,
                1,
                &quad(40.0, 30.0, 60.0, 50.0),
                &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
            )
            .expect("PDFium should create the rectangle");

        let bounds = with_page(engine, document.id, 1, |page| {
            page.annotations()
                .get(0)
                .expect("the rectangle should exist")
                .bounds()
                .expect("the rectangle should have bounds")
        });

        // The fixture's unrotated height is 300pt. A box 30pt down from the top,
        // 50pt tall, sits 220..270pt up from the bottom; 40pt in, 60pt wide, at
        // 40..100. Against those figures, not against the input fed back.
        assert!(
            (bounds.left().value - 40.0).abs() < 0.5,
            "left was {}, expected 40",
            bounds.left().value
        );
        assert!(
            (bounds.right().value - 100.0).abs() < 0.5,
            "right was {}, expected 100",
            bounds.right().value
        );
        assert!(
            (bounds.top().value - 270.0).abs() < 0.5,
            "top was {}, expected 270",
            bounds.top().value
        );
        assert!(
            (bounds.bottom().value - 220.0).abs() < 0.5,
            "bottom was {}, expected 220",
            bounds.bottom().value
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

    // A rectangle is a Stamp holding a drawn path, a different object from a
    // highlight, so surviving the round trip through the file is its own claim.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn writes_a_rectangle_that_survives_a_save() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        // A fill-only box at (50,60)-(150,150): px band (100,120)-(300,300). No
        // border, so every drawn pixel is inside the bounds.
        let band = (100, 120, 300, 300);
        engine
            .add_rect(
                document.id,
                1,
                &quad(50.0, 60.0, 100.0, 90.0),
                &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
            )
            .expect("PDFium should create the rectangle");

        let directory = std::env::temp_dir().join(format!("tfolio-save-rect-{}", document.id));
        fs::create_dir_all(&directory).expect("the test needs a directory to save into");

        let path = directory.join("rectangle.pdf");
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
            "the rectangle should have been written to the file"
        );
        // Where it was drawn and nowhere else, after the round trip through the file.
        let (inside, outside) = ink_inside_and_outside(engine, reopened.id, 1, band);
        assert!(
            inside > 0,
            "the reopened rectangle put no ink where it was drawn"
        );
        assert_eq!(
            outside, 0,
            "the reopened rectangle put ink outside its bounds"
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

    /// A directory of its own for a test that touches real files, so parallel
    /// tests cannot see each other's.
    fn scratch_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "tfolio-{label}-{:016x}",
            getrandom::u64().expect("the system should have randomness")
        ));

        fs::create_dir_all(&directory).expect("the temporary directory should be creatable");
        directory
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn open_by_path_then_save_round_trips() {
        let engine = test_engine();
        let directory = scratch_directory("save-path");
        let path = directory.join("source.pdf");
        fs::write(&path, text_pdf()).expect("the fixture should be writable");

        let document = engine
            .open_from_path(path.clone())
            .expect("PDFium should open the PDF by path");
        assert_eq!(
            document.path.as_deref(),
            path.to_str(),
            "a document opened by path should report that path"
        );

        // The quad (45,40)-(155,70) at two pixels per point, as the highlight
        // placement test draws it.
        let band = (90, 80, 310, 140);
        engine
            .add_highlight(
                document.id,
                1,
                &[quad(45.0, 40.0, 110.0, 30.0)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");
        engine
            .save(document.id)
            .expect("the document should save over its source");

        let left: Vec<_> = fs::read_dir(&directory)
            .expect("the destination directory should be readable")
            .map(|entry| entry.expect("the entry should be readable").path())
            .collect();
        assert_eq!(
            left,
            vec![path.clone()],
            "a save should leave the document and nothing else"
        );

        // Ink, not annotation counts: the reopened file has to *draw* the
        // highlight where it was put, against a clean copy as the baseline.
        let clean = engine
            .open(text_pdf())
            .expect("PDFium should open the clean copy");
        let (clean_inside, clean_outside) = ink_inside_and_outside(engine, clean.id, 1, band);
        let reopened = engine
            .open(fs::read(&path).expect("the saved document should be readable"))
            .expect("PDFium should reopen the saved document");
        let (inside, outside) = ink_inside_and_outside(engine, reopened.id, 1, band);

        assert!(
            inside > clean_inside,
            "the saved highlight should put ink inside its band"
        );
        assert_eq!(
            outside, clean_outside,
            "the saved highlight should change nothing outside its band"
        );

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn refuses_to_save_a_document_opened_from_bytes() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        assert!(document.path.is_none(), "bytes carry no path to report");

        let error = engine
            .save(document.id)
            .expect_err("a document with no source has nothing to save over");
        assert!(
            error.contains("no file to save over"),
            "the refusal should say why: {error}"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn export_adopts_the_destination_of_a_byte_opened_document() {
        let engine = test_engine();
        let directory = scratch_directory("adopt");
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let path = directory.join("adopted.pdf");

        let outcome = engine
            .export_to(document.id, &path)
            .expect("the export should write the document");
        assert!(
            outcome.saved_to_source,
            "a byte-opened document's first export is its save-as"
        );

        // The adoption has to hold: a plain save now has somewhere to go.
        engine
            .save(document.id)
            .expect("the adopted path should take a save");

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn export_beside_the_source_is_not_a_save() {
        let engine = test_engine();
        let directory = scratch_directory("beside");
        let source = directory.join("source.pdf");
        fs::write(&source, minimal_pdf()).expect("the fixture should be writable");

        let document = engine
            .open_from_path(source.clone())
            .expect("PDFium should open the PDF by path");

        let copy = engine
            .export_to(document.id, &directory.join("copy.pdf"))
            .expect("the export should write the copy");
        assert!(
            !copy.saved_to_source,
            "a copy elsewhere leaves the source behind the history"
        );

        // …while exporting *onto* the source is exactly a save, whatever the
        // button was called.
        let onto_source = engine
            .export_to(document.id, &source)
            .expect("the export should overwrite the source");
        assert!(onto_source.saved_to_source);

        fs::remove_dir_all(&directory).ok();
    }

    // Deleting an annotation leaves its resources — for a Chinese note, a whole
    // font subset — in the document, and a straight save writes them all out:
    // measured at 21 KB after five undo/redo rounds against 4 KB clean. The
    // save path reloads to collect them, and this is the byte-count that
    // proves it still does.
    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn a_save_after_deletions_collects_what_they_left_behind() {
        let engine = test_engine();

        // The baseline: the same note added once and never deleted.
        let clean = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        engine
            .add_text_note(
                clean.id,
                1,
                &note_origin(20.0, 100.0),
                "你好",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");
        let baseline = saved_size(engine, clean.id);

        // Five undo/redo rounds, each stranding a fresh subset in the document.
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        for _ in 0..=5 {
            engine
                .add_text_note(
                    document.id,
                    1,
                    &note_origin(20.0, 100.0),
                    "你好",
                    &text_note_style(24.0),
                )
                .expect("PDFium should add the note");
            engine
                .delete_last_annotation(document.id, 1)
                .expect("the session's own note should be removable");
        }
        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "你好",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        let collected = saved_size(engine, document.id);
        assert!(
            collected < baseline + 1_500,
            "five undo/redo rounds saved at {collected} bytes against a clean \
             {baseline}; deleted annotations are not being collected"
        );

        // The reload the collection rides on must not surrender the undo guard:
        // the session's note is still the tail of the page's annotations…
        engine
            .delete_last_annotation(document.id, 1)
            .expect("the session's note should survive the collecting save");
        // …and past the session's own marks it still refuses.
        assert!(
            engine.delete_last_annotation(document.id, 1).is_err(),
            "the guard should still refuse the document's own annotations"
        );
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
                1,
                &[quad(0.0, 0.0, 10.0, 10.0)],
                "#ffd54a",
                0.0,
            )
            .expect_err("a fully transparent highlight draws nothing");
        assert!(error.contains("visible colour"));

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

    /// The runs of dark pixels along a horizontal scanline, as `(start, length)`.
    fn dark_runs_on_scanline(
        engine: &PdfiumEngine,
        document_id: u64,
        page_number: i32,
        y: u32,
    ) -> Vec<(u32, u32)> {
        let image = engine
            .render_bitmap(
                document_id,
                page_number,
                TEST_RENDER_WIDTH,
                MAX_RENDER_WIDTH,
            )
            .expect("PDFium should render the page")
            .into_rgb8();
        let mut runs = Vec::new();
        let mut run = 0;

        for x in 0..image.width() {
            let [red, green, blue] = image.get_pixel(x, y).0;

            if (red as u32 + green as u32 + blue as u32) < 600 {
                run += 1;
            } else if run > 0 {
                runs.push((x - run, run));
                run = 0;
            }
        }

        runs
    }

    // A border has to be drawn at the width the reader chose, and inside the box
    // they dragged — where the preview's `box-sizing: border-box` draws it.
    //
    // A stroke is centred on its path and PDFium clips a stamp to the annotation's
    // `/Rect`, so a path traced along the bounds renders at *half* width: measuring
    // the run of pixels across the border is what tells the two apart. Counting
    // annotations, or total ink, would not.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn draws_a_border_at_its_full_width_inside_the_bounds() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        // A 12pt black border on the box (50,50)-(150,150), no fill. At two pixels
        // per point that is px 100-300, with each border 24px wide and lying
        // *inside* that span: 100-124 on the left, 276-300 on the right.
        engine
            .add_rect(
                document.id,
                1,
                &quad(50.0, 50.0, 100.0, 100.0),
                &rect_style(Some("#000000"), None, 1.0, 0.0, 12.0),
            )
            .expect("PDFium should create the rectangle");

        // Halfway down the box, so the scanline crosses the two vertical edges.
        let runs = dark_runs_on_scanline(engine, document.id, 1, 200);

        assert_eq!(
            runs,
            vec![(100, 24), (276, 24)],
            "a 12pt border should render 24px wide inside the bounds it was dragged"
        );
    }

    fn text_note_style(font_size: f32) -> TextNoteStyle {
        TextNoteStyle {
            font_family: "sans".into(),
            font_size,
            color: "#000000".into(),
            opacity: 1.0,
        }
    }

    fn note_origin(left: f32, top: f32) -> PagePoint {
        PagePoint { left, top }
    }

    /// The bytes a document takes up once saved, which is how the tests below
    /// tell an embedded font from a subset of one.
    fn saved_size(engine: &PdfiumEngine, document_id: u64) -> u64 {
        let directory = scratch_directory("note");
        let destination = directory.join("note.pdf");

        engine
            .save_to(document_id, &destination)
            .expect("PDFium should save the document");

        let size = fs::metadata(&destination)
            .expect("the saved document should exist")
            .len();

        fs::remove_dir_all(&directory).ok();
        size
    }

    // Where the reader clicked is the top of the text, but PDFium draws from the
    // baseline — so a note placed without correcting for that lands a whole line
    // away from the click. Only the pixels can tell: the annotation's own bounds
    // would report the wrong place just as confidently as the right one.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn draws_a_note_where_it_was_asked_for() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "Hello",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        // The note starts at (20,100) and one line of 24pt type is at most 24pt
        // tall, so at two pixels per point every mark belongs inside this box.
        // A baseline mistaken for the top would put the text above it.
        let band = (36, 194, 360, 254);
        let (inside, outside) = ink_inside_and_outside(engine, document.id, 1, band);

        assert!(
            inside > 0,
            "the note should draw inside the box it was given"
        );
        assert_eq!(
            outside, 0,
            "no part of the note should land outside the line it was placed on"
        );

        // Where it landed is only half of it — the ink has to be the *size* a
        // 24pt line is, too. Text scaled into a corner of the right box passes
        // every check above and is still the wrong picture.
        let (left, top, right, bottom) =
            ink_bounds(engine, document.id, 1).expect("the note should draw something");

        // Two pixels to the point on this fixture, so the note's own 20pt left
        // edge is 40px, give or take the first glyph's side bearing.
        assert!(
            (36..=52).contains(&left),
            "the note started at x={left}px rather than the 40px it was given"
        );
        // Its cap height starts a little below the line's top, never above it.
        assert!(
            (200..=224).contains(&top),
            "the note's first line starts at y={top}px rather than just under 200px"
        );

        let height = bottom - top;
        let width = right - left;

        // Cap height to baseline for 24pt type is around 36px at this scale.
        assert!(
            (24..=60).contains(&height),
            "one line of 24pt type rendered {height}px tall"
        );
        assert!(
            (60..=200).contains(&width),
            "five characters of 24pt type rendered {width}px wide"
        );
    }

    // The bug this exists for: a subset stripped of its `cmap` renders every
    // string as the same row of empty boxes. Two different strings drawing the
    // same ink is exactly that failure, and it passes every count-the-annotations
    // check there is.
    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn draws_the_glyphs_the_text_asked_for() {
        let engine = test_engine();
        let style = text_note_style(24.0);
        let ink_of = |text: &str| {
            let document = engine
                .open(minimal_pdf())
                .expect("PDFium should open the PDF");

            engine
                .add_text_note(document.id, 1, &note_origin(20.0, 100.0), text, &style)
                .expect("PDFium should add the note");
            rendered_darkness(engine, document.id, 1)
        };

        let hello = ink_of("你好");
        let other = ink_of("一二");

        assert!(hello > 0, "a Chinese note should draw something");
        assert_ne!(
            hello, other,
            "different characters should draw differently; identical ink means \
             the embedded subset lost its character map and every note is boxes"
        );
        // The same text twice is the control: ink differs above because the
        // glyphs differ, not because a render is unrepeatable.
        assert_eq!(
            hello,
            ink_of("你好"),
            "the same note should draw the same way"
        );
    }

    // The placement test above is Latin, and a Chinese note takes a different
    // route to the page: a subset face rather than a standard one, and so a
    // different ascent to hang the first line from. An ascent PDFium declined
    // to report for a subset would land every Chinese note a line off the click
    // while every Latin one stayed right.
    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn draws_a_chinese_note_where_it_was_asked_for() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "\u{4f60}\u{597d}",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        let (left, top, right, bottom) =
            ink_bounds(engine, document.id, 1).expect("the note should draw something");

        assert!(
            (36..=52).contains(&left),
            "the note started at x={left}px rather than the 40px it was given"
        );
        assert!(
            (200..=224).contains(&top),
            "the note's line starts at y={top}px rather than just under 200px"
        );

        let height = bottom - top;
        let width = right - left;

        // Two full-width characters of 24pt type: about 48px tall and 96 wide.
        assert!(
            (24..=70).contains(&height),
            "one line of 24pt Chinese rendered {height}px tall"
        );
        assert!(
            (60..=200).contains(&width),
            "two characters of 24pt Chinese rendered {width}px wide"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn refuses_a_font_family_it_does_not_offer_for_chinese_too() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let style = TextNoteStyle {
            font_family: "comic".into(),
            ..text_note_style(24.0)
        };

        // Chinese carries its own face and never reaches the standard fonts, so
        // the family it names went unchecked on that path.
        assert!(engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "\u{4f60}\u{597d}",
                &style,
            )
            .is_err());
        assert_eq!(
            with_page(engine, document.id, 1, |page| page.annotations().len()),
            0,
            "a refused note should leave no annotation behind"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn embeds_only_the_glyphs_a_chinese_note_uses() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let before = saved_size(engine, document.id);

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "你好",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        let growth = saved_size(engine, document.id) - before;

        // PDFium embeds whatever bytes it is handed, verbatim — the whole 17 MB
        // face if that is what it gets. A note's worth of glyphs is a few KB, so
        // this holds the subsetting to something no unsubset font could pass.
        assert!(
            growth < 50_000,
            "a two-character note grew the file by {growth} bytes; the font is \
             not being subset to the note"
        );
    }

    // The other half of the same contract: text the standard 14 can draw embeds
    // nothing at all, which is the common case and should stay free.
    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn embeds_no_font_for_a_latin_note() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let before = saved_size(engine, document.id);

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "Hello",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        let growth = saved_size(engine, document.id) - before;

        // Between the two outcomes, not merely above the smaller: embedding
        // even the tightest possible subset of the bundled face costs ~3.4 KB
        // against ~650 bytes for a standard font, and a ceiling above both would
        // pass whether or not a font went in.
        assert!(
            growth < 2_000,
            "a Latin note grew the file by {growth} bytes, so it embedded a font \
             it had no need of"
        );
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
    fn writes_a_chinese_note_that_survives_a_save() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "你好",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        let drawn = rendered_darkness(engine, document.id, 1);
        let directory = scratch_directory("note-save");
        let destination = directory.join("note.pdf");

        engine
            .save_to(document.id, &destination)
            .expect("PDFium should save the document");

        let reopened = engine
            .open(fs::read(&destination).expect("the saved document should be readable"))
            .expect("PDFium should reopen the saved document");

        assert_eq!(
            rendered_darkness(engine, reopened.id, 1),
            drawn,
            "a saved note should reopen drawing exactly what it drew before"
        );

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn multiple_lines_stack_down_the_page() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 40.0),
                "One\nTwo",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");

        // The first line's own band. The second sits a line below it, so ink
        // outside proves the lines were not drawn on top of each other.
        let (first_line, rest) = ink_inside_and_outside(engine, document.id, 1, (0, 0, 400, 140));

        assert!(first_line > 0, "the first line should draw");
        assert!(rest > 0, "the second line should draw below the first");
    }

    #[test]
    #[ignore = "requires `bun run pdfium:download`"]
    fn rejects_an_unusable_note() {
        let engine = test_engine();
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");
        let origin = note_origin(20.0, 100.0);
        let style = text_note_style(24.0);

        let cases: Vec<(&str, Result<(), String>)> = vec![
            (
                "empty text",
                engine.add_text_note(document.id, 1, &origin, "", &style),
            ),
            (
                "whitespace only",
                engine.add_text_note(document.id, 1, &origin, "   \n  ", &style),
            ),
            (
                "a coordinate off the scale",
                engine.add_text_note(document.id, 1, &note_origin(f32::NAN, 0.0), "Hi", &style),
            ),
            (
                "a font size past the control's range",
                engine.add_text_note(document.id, 1, &origin, "Hi", &text_note_style(500.0)),
            ),
            (
                "a font size below the control's range",
                engine.add_text_note(document.id, 1, &origin, "Hi", &text_note_style(1.0)),
            ),
            (
                "an invisible note",
                engine.add_text_note(
                    document.id,
                    1,
                    &origin,
                    "Hi",
                    &TextNoteStyle {
                        opacity: 0.0,
                        ..text_note_style(24.0)
                    },
                ),
            ),
            (
                "an unreadable colour",
                engine.add_text_note(
                    document.id,
                    1,
                    &origin,
                    "Hi",
                    &TextNoteStyle {
                        color: "not a colour".into(),
                        ..text_note_style(24.0)
                    },
                ),
            ),
            (
                "a font family this app does not offer",
                engine.add_text_note(
                    document.id,
                    1,
                    &origin,
                    "Hi",
                    &TextNoteStyle {
                        font_family: "comic".into(),
                        ..text_note_style(24.0)
                    },
                ),
            ),
            (
                "a note longer than the ceiling",
                engine.add_text_note(document.id, 1, &origin, &"a".repeat(5000), &style),
            ),
            (
                "a page that does not exist",
                engine.add_text_note(document.id, 2, &origin, "Hi", &style),
            ),
        ];

        for (case, result) in cases {
            assert!(result.is_err(), "{case} should be refused");
        }

        // Nothing was drawn and nothing was left behind: every refusal above
        // happened before a mark reached the page, or wound one back if it had.
        assert_eq!(
            rendered_darkness(engine, document.id, 1),
            0,
            "a refused note should leave the page as it was"
        );
        assert_eq!(
            with_page(engine, document.id, 1, |page| page.annotations().len()),
            0,
            "a refused note should leave no annotation behind"
        );
    }
}
