use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
};

use image::{imageops, DynamicImage, ImageFormat};
use pdfium_render::prelude::*;
use tauri::AppHandle;

use super::{
    font::{
        bold_cjk_font, cjk_font_path, needs_embedded_font, regular_cjk_font, serif_cjk_font_path,
        standard_face, subset_for, StandardFace,
    },
    geometry::{
        annotation_color, page_rect_to_pdfium, page_rotation_degrees, quad_points_from_rect,
        union_rect, unrotated_page_height, unrotated_page_size, within_page_range,
        MAX_RECT_EFFECT_STRENGTH, MAX_TEXT_NOTE_CHARS, MAX_TEXT_NOTE_FONT_SIZE,
        MAX_TEXT_NOTE_LINES, MIN_RECT_EFFECT_STRENGTH, MIN_RECT_OPACITY, MIN_TEXT_NOTE_FONT_SIZE,
        MIN_TEXT_NOTE_OPACITY, TEXT_NOTE_BOUNDS_MARGIN, TEXT_NOTE_LINE_HEIGHT,
    },
    library::bind_pdfium,
    page_numbers::{
        average_luminance, ink_color, page_number_center, page_number_display_box, DisplayBox,
        PageNumberPlacement, PageNumbersConfig, FONT_SIZE as PAGE_NUMBER_FONT_SIZE,
    },
    size_limit_error,
    watermark::{
        add_document_object_count, watermark_placements, WatermarkConfig, WatermarkPlacement,
    },
    ExportOutcome, MergeOutcome, PagePoint, PagePointsRect, PdfDocumentInfo, PdfOutlineItem,
    PdfPageInfo, PdfStructureUpdate, PdfTextSpan, RectEffect, RectEffectKind, RectStyle,
    TextNoteStyle, MAX_PDF_BYTES,
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
// Image effects capture page pixels at a print-like resolution, capped at the
// same dimensions as an ordinary page render so one drag cannot allocate an
// unbounded bitmap or inflate the saved file without limit.
const RECT_EFFECT_DPI: f32 = 150.0;
const POINTS_PER_INCH: f32 = 72.0;
// Smart colour only needs an average luminance under one small label, so it
// samples at a fraction of a print-resolution capture — a few pixels across the
// label is enough to pick black or white.
const PAGE_NUMBER_SAMPLE_DPI: f32 = 24.0;
// A little slack around the label's box, in display points, so the sample reads
// the drop the number sits on rather than a hairline of it.
const PAGE_NUMBER_SAMPLE_PADDING: f32 = 4.0;

#[derive(Debug, PartialEq)]
struct DisplayRect {
    height: f32,
    left: f32,
    top: f32,
    width: f32,
}

/// One page-content layer's run of objects at the tail of a page, in tail
/// order.
///
/// `identities` holds one string per object, read back from PDFium after the
/// object was attached rather than the source text: an embedded font may map a
/// character to a compatibility equivalent, so the bytes written are not always
/// what PDFium reads, and only the read-back survives to be compared on a later
/// guard.
#[derive(Clone, Debug)]
struct OwnedSegment {
    object_count: usize,
    identities: Vec<String>,
}

/// Everything this session appended to one page, past the content it found
/// there. A page's objects are `[ base | segment 0 | segment 1 | … ]`, the
/// segments in a fixed layer order (a watermark beneath, page numbers above),
/// so a change to one layer leaves the other exactly where the reader saw it.
#[derive(Clone, Debug)]
struct OwnedTailState {
    /// Top-level page objects that existed before any owned layer covered this
    /// page.
    base_objects: usize,
    segments: Vec<OwnedSegment>,
}

impl OwnedTailState {
    /// The length of the owned tail — what a rebuild pops and a guard measures.
    fn owned_objects(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| segment.object_count)
            .sum()
    }
}

/// A deleted page's copy and the session state that travelled with it, held so
/// an undo can put both back exactly. Self-contained: the copies live in their
/// own document, released with the stash.
struct PageStash {
    document: PdfDocument<'static>,
    /// One record per deleted page, ascending by original position — the order
    /// their copies sit in `document`, and the order a restore reinserts them.
    pages: Vec<StashedPage>,
}

struct StashedPage {
    /// The page's 1-based position at the moment it was deleted. LIFO undo
    /// guarantees the document is back in that shape when a restore runs.
    position: i32,
    page_id: u64,
    added: u32,
    revision: u64,
    owned: Option<OwnedTailState>,
    /// Whether the page came from a merge, so a restore puts it back into the
    /// merged-content set that forbids overwriting the first file.
    merged: bool,
}

/// The page-content layers this open session owns. A layer's config is `Some`
/// while it is active; the value as a whole is dropped to `None` once none is.
/// Keyed by stable page id so the record survives the structure operations
/// M7/M8 add; a page whose tail has empty `segments` was inserted or merged
/// after a layer was applied — owned, but bare, until a re-apply covers it.
#[derive(Clone, Debug)]
struct OwnedContentState {
    watermark: Option<WatermarkConfig>,
    page_numbers: Option<PageNumbersConfig>,
    per_page: HashMap<u64, OwnedTailState>,
}

impl OwnedContentState {
    /// Whether any layer is still active. When false the session owns nothing,
    /// the state is dropped, and a save is no longer refused.
    fn has_active_layer(&self) -> bool {
        self.watermark.is_some() || self.page_numbers.is_some()
    }
}

/// One active layer's planned objects for one page. Computed for every page
/// before any is touched, so a measurement, object-limit, or sampling failure
/// leaves the document untouched.
struct WatermarkLayerPlan {
    object_rotation: f32,
    placements: Vec<WatermarkPlacement>,
}

/// A single page-number object, planned: its text, the angle that cancels the
/// page's `/Rotate`, and where its measured bounds go. The ink is chosen later,
/// in the rebuild — for smart colour, `sample_box` says where to read the drop,
/// which is sampled only *after* any previous tail is popped, so a replacement
/// reads the real backdrop and not the label it is about to overwrite.
struct PageNumberLayerPlan {
    text: String,
    object_rotation: f32,
    center: PageNumberPlacement,
    sample_box: Option<DisplayBox>,
}

struct PageOwnedPlan {
    base_objects: usize,
    page_number: i32,
    watermark: Option<WatermarkLayerPlan>,
    page_number_label: Option<PageNumberLayerPlan>,
}

/// The watermark layer's inputs to a rebuild, prepared before the document lock
/// is taken: the config, its resolved colour, and — when the text leaves
/// Latin-1 — the bundled face subset to embed. Its font token is loaded inside
/// the rebuild, once, and reused for every page.
struct WatermarkResources {
    config: WatermarkConfig,
    color: PdfColor,
    embedded: Option<Vec<u8>>,
}

/// The page-number layer's inputs to a rebuild: the config and the bundled
/// serif face bytes, already instanced and subset by the font pipeline, so they
/// are embedded whole. The font token is loaded inside the rebuild, once.
struct PageNumbersResources {
    config: PageNumbersConfig,
    serif: Vec<u8>,
}

/// Where an unrotated, top-left page rectangle lands after the PDF's intrinsic
/// clockwise rotation. The page bitmap is in this displayed space.
fn rect_in_display_space(
    rect: &PagePointsRect,
    unrotated_width: f32,
    unrotated_height: f32,
    rotation: f32,
) -> DisplayRect {
    match rotation as i32 {
        90 => DisplayRect {
            height: rect.width,
            left: unrotated_height - (rect.top + rect.height),
            top: rect.left,
            width: rect.height,
        },
        180 => DisplayRect {
            height: rect.height,
            left: unrotated_width - (rect.left + rect.width),
            top: unrotated_height - (rect.top + rect.height),
            width: rect.width,
        },
        270 => DisplayRect {
            height: rect.width,
            left: rect.top,
            top: unrotated_width - (rect.left + rect.width),
            width: rect.height,
        },
        _ => DisplayRect {
            height: rect.height,
            left: rect.left,
            top: rect.top,
            width: rect.width,
        },
    }
}

fn rotated_watermark_object<'a>(
    document: &PdfDocument<'a>,
    font: PdfFontToken,
    config: &WatermarkConfig,
    color: PdfColor,
    object_rotation: f32,
) -> Result<PdfPageTextObject<'a>, String> {
    let mut object = PdfPageTextObject::new(
        document,
        &config.text,
        font,
        PdfPoints::new(config.font_size),
    )
    .map_err(|error| format!("PDFium rejected the watermark text: {error}"))?;

    object
        .set_fill_color(color)
        .map_err(|error| format!("PDFium rejected the watermark colour: {error}"))?;
    object
        .rotate_clockwise_degrees(object_rotation)
        .map_err(|error| format!("PDFium could not rotate the watermark: {error}"))?;

    Ok(object)
}

/// Builds the page-number label as a text object in the serif face, coloured
/// and turned to cancel the page's `/Rotate` — the same shape as
/// `rotated_watermark_object`, for the other owned layer.
fn rotated_page_number_object<'a>(
    document: &PdfDocument<'a>,
    font: PdfFontToken,
    text: &str,
    color: PdfColor,
    object_rotation: f32,
) -> Result<PdfPageTextObject<'a>, String> {
    let mut object =
        PdfPageTextObject::new(document, text, font, PdfPoints::new(PAGE_NUMBER_FONT_SIZE))
            .map_err(|error| format!("PDFium rejected the page-number text: {error}"))?;

    object
        .set_fill_color(color)
        .map_err(|error| format!("PDFium rejected the page-number colour: {error}"))?;
    object
        .rotate_clockwise_degrees(object_rotation)
        .map_err(|error| format!("PDFium could not rotate the page number: {error}"))?;

    Ok(object)
}

/// Translates a measured text object so its bounds' centre lands on a target
/// centre in unrotated page space. Shared by both owned layers.
fn place_text_object(
    mut object: PdfPageTextObject<'static>,
    target_x: f32,
    target_y: f32,
) -> Result<PdfPageTextObject<'static>, String> {
    let bounds = object
        .bounds()
        .map_err(|error| format!("PDFium could not measure an owned object: {error}"))?;
    let center_x = (bounds.left().value + bounds.right().value) / 2.0;
    let center_y = (bounds.bottom().value + bounds.top().value) / 2.0;

    object
        .translate(
            PdfPoints::new(target_x - center_x),
            PdfPoints::new(target_y - center_y),
        )
        .map_err(|error| format!("PDFium could not place an owned object: {error}"))?;

    Ok(object)
}

struct OpenDocument {
    document: PdfDocument<'static>,
    /// Position -> stable page id. Assigned `0..n` at open; every inserted page
    /// takes a fresh id and an id is never reused within a session. Structure
    /// operations permute or edit this vector, which is what lets every
    /// id-keyed map below survive them.
    page_ids: Vec<u64>,
    next_page_id: u64,
    /// Deleted pages awaiting a possible undo, keyed by the history entry that
    /// deleted them. A delete under an occupied key replaces the stash: the key
    /// identifies one history entry, so a redo of that delete re-stashes the
    /// same logical pages — and an insert undone more than once reuses its key.
    stashes: HashMap<u64, PageStash>,
    /// How many annotations this session has added to each page, keyed by
    /// stable page id.
    ///
    /// PDFium appends, so the reader's own marks are the tail of a page's
    /// annotations and this is how long that tail is. Past it lie the document's
    /// own — links, form fields, comments — which an undo must never reach.
    added: HashMap<u64, u32>,
    /// Monotonic content version per page, keyed by stable page id. Rectangle
    /// effects release the global PDFium lock while processing owned pixels;
    /// this detects an annotation that changed the source page before the
    /// processed image is attached again.
    revisions: HashMap<u64, u64>,
    /// Page ids that came from a merge and are still in the document. While any
    /// remain, this document holds another file's pages, so — like a watermark —
    /// it may only be exported as a copy, never written back over the first
    /// file. Emptied when a merge is undone (its pages deleted) and refilled
    /// when it is redone (its pages restored), so the guard tracks what is
    /// actually present, not merely what once happened.
    merged_page_ids: HashSet<u64>,
    /// The file this document was opened from, and so the file a save writes
    /// back over. `None` — opened from bytes — leaves nothing to overwrite,
    /// and a first export adopts its destination as the source.
    source_path: Option<PathBuf>,
    /// Whether this session has deleted an annotation or page object. PDFium
    /// leaves referenced fonts, appearances, and content streams behind until a
    /// save-and-reload collects them, so the next write takes that route.
    needs_compaction: bool,
    /// The page-content layers (watermark, page numbers) this open session
    /// owns, and where each page's owned tail sits. `None` once the session
    /// owns nothing.
    owned_content: Option<OwnedContentState>,
}

impl OpenDocument {
    /// Resolves a 1-based page number to the page's stable id — the key every
    /// per-page map uses, which survives reordering, deletion, and insertion.
    /// Doubles as the page-number validation every command needs.
    fn page_id(&self, page_number: i32) -> Result<u64, String> {
        page_index(page_number, self.page_ids.len())
            .map(|index| self.page_ids[index])
            .ok_or_else(|| format!("page {page_number} does not exist"))
    }

    /// Bumps every page's revision so an M5 effect captured before a structure
    /// change fails its revision check after it: every structure command
    /// permutes or resizes the page list, so no capture survives one.
    fn invalidate_all_page_revisions(&mut self) {
        for &page_id in &self.page_ids {
            *self.revisions.entry(page_id).or_insert(0) += 1;
        }
    }
}

/// A 1-based page number as a zero-based index, if it lands inside the
/// document. Checked arithmetic throughout: the number is the WebView's, and
/// `i32::MIN - 1` must refuse rather than overflow.
fn page_index(page_number: i32, page_count: usize) -> Option<usize> {
    page_number
        .checked_sub(1)
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| *index < page_count)
}

/// Checks `order` names every page exactly once, handing back the zero-based
/// indices PDFium moves. `None` is the identity order — a no-op.
fn validate_page_order(order: &[i32], page_count: usize) -> Result<Option<Vec<i32>>, String> {
    if order.len() != page_count {
        return Err("the page order must name every page exactly once".into());
    }

    let mut seen = vec![false; page_count];

    for &page_number in order {
        let Some(index) = page_index(page_number, page_count) else {
            return Err(format!("page {page_number} does not exist"));
        };

        if seen[index] {
            return Err(format!(
                "page {page_number} appears twice in the page order"
            ));
        }

        seen[index] = true;
    }

    if order
        .iter()
        .enumerate()
        .all(|(index, page_number)| *page_number == index as i32 + 1)
    {
        return Ok(None);
    }

    Ok(Some(
        order.iter().map(|page_number| page_number - 1).collect(),
    ))
}

/// Checks the pages named for deletion exist, are distinct, and leave at least
/// one page behind; hands back their zero-based indices in ascending order.
fn validate_pages_to_delete(page_numbers: &[i32], page_count: usize) -> Result<Vec<usize>, String> {
    if page_numbers.is_empty() {
        return Err("a deletion needs at least one page".into());
    }

    let mut seen = vec![false; page_count];

    for &page_number in page_numbers {
        let Some(index) = page_index(page_number, page_count) else {
            return Err(format!("page {page_number} does not exist"));
        };

        if seen[index] {
            return Err(format!("page {page_number} appears twice in the deletion"));
        }

        seen[index] = true;
    }

    if page_numbers.len() >= page_count {
        return Err("a document must keep at least one page".into());
    }

    Ok(seen
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| selected.then_some(index))
        .collect())
}

/// The entry for `document_id`, with the one wording for a closed document.
fn open_entry(
    documents: &HashMap<u64, OpenDocument>,
    document_id: u64,
) -> Result<&OpenDocument, String> {
    documents
        .get(&document_id)
        .ok_or_else(|| "PDF document is no longer open".to_string())
}

fn open_entry_mut(
    documents: &mut HashMap<u64, OpenDocument>,
    document_id: u64,
) -> Result<&mut OpenDocument, String> {
    documents
        .get_mut(&document_id)
        .ok_or_else(|| "PDF document is no longer open".to_string())
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
    /// The font's static Regular (weight 400) instance, created on the first
    /// note that needs it. Most sessions never touch the ~17 MB variable source,
    /// so it is not read or resolved at startup — and once resolved it is kept,
    /// because every CJK note subsets it again.
    cjk_font: OnceLock<Vec<u8>>,
    /// The same bundled face resolved to weight 800, created only if a bold CJK
    /// watermark needs it and then reused by later replacements.
    cjk_bold_font: OnceLock<Vec<u8>>,
    /// Where the bundled serif face — the page-number face — is, resolved at
    /// startup for the same reason `cjk_font_path` is.
    serif_cjk_font_path: Option<PathBuf>,
    /// The serif face bytes, read on the first page-number apply that needs
    /// them and kept. Already instanced and subset by `download-fonts.mjs`, so
    /// unlike the sans face this is embedded whole, not cut again.
    serif_cjk_font: OnceLock<Vec<u8>>,
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
            cjk_bold_font: OnceLock::new(),
            serif_cjk_font_path: serif_cjk_font_path(app),
            serif_cjk_font: OnceLock::new(),
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
    // The e2e build waives the check at both its call sites — `open_pdf_from_path`
    // and `merge_pdf_from_path` — so the whole method is dead there.
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    pub(super) fn is_approved(&self, path: &Path) -> bool {
        self.approved_paths
            .lock()
            .map(|approved| approved.contains(path))
            .unwrap_or(false)
    }

    /// Locks the store — and with it PDFium itself — behind the one wording
    /// for a poisoned lock.
    fn lock_documents(&self) -> Result<MutexGuard<'_, HashMap<u64, OpenDocument>>, String> {
        self.documents
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())
    }

    /// A new one-page A4 document, built in memory. It has no file of its own,
    /// so — exactly like one opened from bytes — a save has nowhere to write
    /// until an export adopts a destination as its source.
    pub(super) fn create_blank(&self) -> Result<PdfDocumentInfo, String> {
        let bytes = {
            // Building a document is PDFium work like any other, so it is done
            // under the store's lock — given back before `open_with_source`
            // takes it again.
            let _documents = self.lock_documents()?;
            let mut document = self
                .pdfium
                .create_new_pdf()
                .map_err(|error| format!("PDFium could not create a document: {error}"))?;
            let page = document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .map_err(|error| format!("PDFium could not create the first page: {error}"))?;

            drop(page);

            document
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not build the new document: {error}"))?
        };

        self.open_with_source(bytes, None)
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
        let mut documents = self.lock_documents()?;
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not open the document: {error}"))?;
        let PdfStructureUpdate {
            num_pages,
            pages,
            outline,
        } = document_layout(&document);
        let id = self.next_document_id.fetch_add(1, Ordering::Relaxed);
        let path = source_path
            .as_deref()
            .map(|path| path.to_string_lossy().into_owned());

        documents.insert(
            id,
            OpenDocument {
                added: HashMap::new(),
                document,
                merged_page_ids: HashSet::new(),
                needs_compaction: false,
                next_page_id: num_pages as u64,
                owned_content: None,
                page_ids: (0..num_pages as u64).collect(),
                revisions: HashMap::new(),
                source_path,
                stashes: HashMap::new(),
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

        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;

        entry.page_id(page_number)?;

        let page = entry
            .document
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
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;

        entry.page_id(page_number)?;

        let page = entry
            .document
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

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

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

        *entry.added.entry(page_id).or_insert(0) += 1;
        *entry.revisions.entry(page_id).or_insert(0) += 1;

        Ok(())
    }

    /// Replaces the pixels inside `bounds` with a raster treatment carried by
    /// one Stamp annotation. The page content under the image is untouched and
    /// remains available to text extraction.
    pub(super) fn add_rect_effect(
        &self,
        document_id: u64,
        page_number: i32,
        bounds: &PagePointsRect,
        effect: &RectEffect,
    ) -> Result<(), String> {
        if ![bounds.left, bounds.top, bounds.width, bounds.height]
            .iter()
            .all(|value| within_page_range(*value))
        {
            return Err("a rectangle effect's coordinates are out of range".into());
        }
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err("a rectangle effect needs a positive width and height".into());
        }
        if !(MIN_RECT_EFFECT_STRENGTH..=MAX_RECT_EFFECT_STRENGTH).contains(&effect.strength) {
            return Err("a rectangle effect's strength is out of range".into());
        }

        // Render before creating the annotation, so its image can include every
        // earlier mark on the page but never recursively capture itself. Only
        // this capture needs PDFium: once it is an owned DynamicImage, release
        // the global lock so renders and text extraction can proceed during the
        // comparatively expensive crop, treatment, rotation, and byte shuffle.
        let (
            rendered,
            rotation,
            displayed_width,
            displayed_height,
            unrotated_width,
            unrotated_height,
            captured_page_id,
            captured_revision,
        ) = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;
            let page_id = entry.page_id(page_number)?;

            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let rotation = page_rotation_degrees(&page);
            let displayed_width = page.width().value;
            let displayed_height = page.height().value;

            if !displayed_width.is_finite()
                || !displayed_height.is_finite()
                || displayed_width <= 0.0
                || displayed_height <= 0.0
            {
                return Err("a rectangle effect needs a page with usable dimensions".into());
            }

            let (unrotated_width, unrotated_height) = if rotation == 90.0 || rotation == 270.0 {
                (displayed_height, displayed_width)
            } else {
                (displayed_width, displayed_height)
            };

            if bounds.left < 0.0
                || bounds.top < 0.0
                || bounds.left + bounds.width > unrotated_width
                || bounds.top + bounds.height > unrotated_height
            {
                return Err("a rectangle effect must stay inside its page".into());
            }

            let scale = (RECT_EFFECT_DPI / POINTS_PER_INCH)
                .min(MAX_RENDER_WIDTH as f32 / displayed_width)
                .min(MAX_RENDER_HEIGHT as f32 / displayed_height);
            let render_width = (displayed_width * scale)
                .round()
                .clamp(1.0, MAX_RENDER_WIDTH as f32) as i32;
            let config = PdfRenderConfig::new()
                .set_target_width(render_width)
                .set_maximum_width(MAX_RENDER_WIDTH)
                .set_maximum_height(MAX_RENDER_HEIGHT)
                .render_annotations(true)
                .render_form_data(true);
            let rendered = page
                .render_with_config(&config)
                .and_then(|bitmap| bitmap.as_image())
                .map_err(|error| {
                    format!("PDFium could not capture page {page_number} for an effect: {error}")
                })?;

            (
                rendered,
                rotation,
                displayed_width,
                displayed_height,
                unrotated_width,
                unrotated_height,
                page_id,
                entry.revisions.get(&page_id).copied().unwrap_or(0),
            )
        };

        let displayed = rect_in_display_space(bounds, unrotated_width, unrotated_height, rotation);
        let scale_x = rendered.width() as f32 / displayed_width;
        let scale_y = rendered.height() as f32 / displayed_height;
        let left = (displayed.left * scale_x).floor().max(0.0) as u32;
        let top = (displayed.top * scale_y).floor().max(0.0) as u32;
        let right = ((displayed.left + displayed.width) * scale_x)
            .ceil()
            .min(rendered.width() as f32) as u32;
        let bottom = ((displayed.top + displayed.height) * scale_y)
            .ceil()
            .min(rendered.height() as f32) as u32;

        if right <= left || bottom <= top {
            return Err("a rectangle effect is too small to capture any pixels".into());
        }

        let captured = rendered.crop_imm(left, top, right - left, bottom - top);
        let source_pixels_per_point = (scale_x + scale_y) / 2.0;
        let processed = match effect.kind {
            RectEffectKind::Mosaic => {
                let block = (effect.strength * source_pixels_per_point).round().max(1.0) as u32;
                let reduced_width = captured.width().div_ceil(block).max(1);
                let reduced_height = captured.height().div_ceil(block).max(1);
                let reduced = imageops::resize(
                    &captured,
                    reduced_width,
                    reduced_height,
                    imageops::FilterType::Nearest,
                );

                DynamicImage::ImageRgba8(imageops::resize(
                    &reduced,
                    captured.width(),
                    captured.height(),
                    imageops::FilterType::Nearest,
                ))
            }
            RectEffectKind::Blur => DynamicImage::ImageRgba8(imageops::blur(
                &captured,
                effect.strength * source_pixels_per_point,
            )),
        };

        // The render includes the page's intrinsic clockwise rotation. Page
        // objects live before that rotation, so turn the crop back before it is
        // embedded; PDFium will apply the page rotation once when it draws.
        let processed = match rotation as i32 {
            90 => processed.rotate270(),
            180 => processed.rotate180(),
            270 => processed.rotate90(),
            _ => processed,
        };
        let pixel_width = i32::try_from(processed.width())
            .map_err(|_| "a rectangle effect image is too wide".to_string())?;
        let pixel_height = i32::try_from(processed.height())
            .map_err(|_| "a rectangle effect image is too tall".to_string())?;
        let mut bgra = processed.into_rgba8().into_raw();

        // `pdfium-render::set_image()` performs this RGBA -> BGRA copy after it
        // has created a PDFium bitmap. Shuffle the owned bytes while unlocked,
        // then hand that buffer to a PdfBitmap during the short commit phase.
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        let placeholder = DynamicImage::new_rgba8(1, 1);
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // The commit belongs to the page the capture read, wherever that page
        // sits now — found by id, so a page inserted at the captured number can
        // never receive another page's pixels. A structure change also bumps
        // every revision, so a moved page still fails the check below.
        let page_index = entry
            .page_ids
            .iter()
            .position(|id| *id == captured_page_id)
            .ok_or_else(|| {
                "the page changed while its rectangle effect was being prepared".to_string()
            })?;

        if entry.revisions.get(&captured_page_id).copied().unwrap_or(0) != captured_revision {
            return Err("the page changed while its rectangle effect was being prepared".into());
        }

        let rect = page_rect_to_pdfium(bounds, unrotated_height);
        let mut image = PdfPageImageObject::new_with_size(
            &entry.document,
            &placeholder,
            PdfPoints::new(bounds.width),
            PdfPoints::new(bounds.height),
        )
        .map_err(|error| format!("PDFium could not create the rectangle effect image: {error}"))?;
        let bitmap = PdfBitmap::from_bytes(
            pixel_width,
            pixel_height,
            PdfBitmapFormat::BGRA,
            bgra.as_mut_slice(),
        )
        .map_err(|error| {
            format!("PDFium could not prepare the rectangle effect pixels: {error}")
        })?;
        image.set_bitmap(&bitmap).map_err(|error| {
            format!("PDFium could not apply the rectangle effect pixels: {error}")
        })?;
        drop(bitmap);
        image
            .translate(rect.left(), rect.bottom())
            .map_err(|error| {
                format!("PDFium could not place the rectangle effect image: {error}")
            })?;

        // Annotation creation attaches immediately. Anything after it can fail,
        // so the same rollback used by the vector rectangle is required here.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_index as i32)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a rectangle effect: {error}"))?;
        let described = (|| {
            annotation.set_bounds(rect).map_err(|error| {
                format!("PDFium rejected the rectangle effect's bounds: {error}")
            })?;
            annotation
                .objects_mut()
                .add_image_object(image)
                .map_err(|error| {
                    format!("PDFium rejected the rectangle effect's image: {error}")
                })?;
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

        *entry.added.entry(captured_page_id).or_insert(0) += 1;
        *entry.revisions.entry(captured_page_id).or_insert(0) += 1;

        Ok(())
    }

    /// Draws a rectangle on `page_number` — one mark, so one step to take back.
    ///
    /// Carried by a Stamp annotation holding a hand-built path object, not a
    /// Square, so it is the same kind of mark the blur and the mosaic leave and
    /// one deletion path takes any of them back off.
    ///
    /// The cost is that other tools see a stamp rather than a native rectangle
    /// they could edit — acceptable while this app only creates and undoes.
    /// Drawing the path ourselves keeps the colour and the opacity a real,
    /// rendered thing the CSS preview matches, rather than an `/IC` and a `/CA`
    /// a reader's viewer may or may not honour.
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

        // The opacity slider's range (see annotationStyles.ts) is the contract,
        // enforced on both sides of the boundary: a value the reader could never
        // have chosen is refused rather than quietly clamped into a different
        // mark than they drew. The floor is also what keeps a rectangle a
        // visible one — a fully transparent block would be accepted, stored,
        // saved, invisible, yet still recorded as an edit, which is the failure
        // this project measures pixels to catch. `contains` rejects a non-finite
        // opacity on the way.
        if !(MIN_RECT_OPACITY..=1.0).contains(&style.opacity) {
            return Err("a rectangle's style values are out of range".into());
        }

        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err("a rectangle needs a positive width and height".into());
        }

        let fill = annotation_color(&style.color, style.opacity)?;
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

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

        // A free object until it is added below, so a failure while it is being
        // drawn has nothing to take off the page. Traced along the bounds
        // themselves: with no stroke to centre on the path, every pixel the fill
        // puts down is inside the box the reader dragged, which is where the
        // preview draws it.
        let mut path = PdfPagePathObject::new(
            &entry.document,
            rect.left(),
            rect.bottom(),
            None,
            None,
            Some(fill),
        )
        .map_err(|error| format!("PDFium could not start the rectangle: {error}"))?;

        for (x, y) in [
            (rect.right(), rect.bottom()),
            (rect.right(), rect.top()),
            (rect.left(), rect.top()),
        ] {
            path.line_to(x, y)
                .map_err(|error| format!("PDFium rejected a rectangle edge: {error}"))?;
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

        *entry.added.entry(page_id).or_insert(0) += 1;
        *entry.revisions.entry(page_id).or_insert(0) += 1;

        Ok(())
    }

    /// The bundled CJK font's static Regular bytes, resolved once and kept.
    fn cjk_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.cjk_font.get() {
            return Ok(bytes);
        }

        let path = self.cjk_font_path.as_ref().ok_or_else(|| {
            "the bundled font is missing; run `bun run fonts:download`".to_string()
        })?;
        let source = fs::read(path)
            .map_err(|error| format!("the bundled font could not be read: {error}"))?;
        let bytes = regular_cjk_font(&source)?;

        // Two notes can reach here at once and both resolve the font; whichever
        // stores first wins and the other's copy is dropped. Both then see the
        // same Regular instance, which is all that matters.
        let _ = self.cjk_font.set(bytes);

        self.cjk_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the bundled font could not be cached".to_string())
    }

    /// The bundled CJK font's static weight-800 bytes, resolved once and kept.
    fn cjk_bold_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.cjk_bold_font.get() {
            return Ok(bytes);
        }

        let path = self.cjk_font_path.as_ref().ok_or_else(|| {
            "the bundled font is missing; run `bun run fonts:download`".to_string()
        })?;
        let source = fs::read(path)
            .map_err(|error| format!("the bundled font could not be read: {error}"))?;
        let bytes = bold_cjk_font(&source)?;

        // A concurrent replacement may resolve the same instance too; both
        // byte sequences are equivalent, so whichever stores first wins.
        let _ = self.cjk_bold_font.set(bytes);

        self.cjk_bold_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the bundled bold font could not be cached".to_string())
    }

    /// The bundled serif face bytes, read once and kept. The font pipeline has
    /// already instanced it to Regular and cut it to the digit and dash glyphs,
    /// so — unlike the sans face — nothing is instanced or subset here.
    fn serif_cjk_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.serif_cjk_font.get() {
            return Ok(bytes);
        }

        let path = self.serif_cjk_font_path.as_ref().ok_or_else(|| {
            "the bundled serif font is missing; run `bun run fonts:download`".to_string()
        })?;
        let source = fs::read(path)
            .map_err(|error| format!("the bundled serif font could not be read: {error}"))?;

        // Two applies can reach here at once; whichever stores first wins and
        // the other copy is dropped, both then seeing the same bytes.
        let _ = self.serif_cjk_font.set(source);

        self.serif_cjk_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the bundled serif font could not be cached".to_string())
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

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

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

        *entry.added.entry(page_id).or_insert(0) += 1;
        *entry.revisions.entry(page_id).or_insert(0) += 1;

        Ok(())
    }

    /// Verifies that every page still ends with exactly the objects this
    /// session recorded, across every owned layer. Whole-document preflight:
    /// once a page fails, no earlier page may already have lost content.
    fn verify_owned_tail(
        document: &PdfDocument<'static>,
        page_ids: &[u64],
        state: &OwnedContentState,
    ) -> Result<(), String> {
        let page_count = document.pages().len();

        // `page_ids` is the engine's own mirror of the page list; drifted from
        // the document, every id-keyed record below would name the wrong pages.
        if page_ids.len() != page_count as usize {
            return Err("the owned-content record does not cover every page".into());
        }

        if state.per_page.len() != page_ids.len() {
            return Err("the owned-content record does not cover every page".into());
        }

        for (index, page_id) in page_ids.iter().enumerate() {
            let page_number = index as i32 + 1;
            let tail = state
                .per_page
                .get(page_id)
                .ok_or_else(|| format!("the owned-content record is missing page {page_number}"))?;
            let expected = tail
                .base_objects
                .checked_add(tail.owned_objects())
                .ok_or_else(|| "the owned object count overflowed".to_string())?;
            let page = document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let objects = page.objects();

            if objects.len() != expected {
                return Err(format!(
                    "page {page_number}'s content no longer ends where this session's marks should"
                ));
            }

            // A page inserted or merged after a layer was applied owns nothing:
            // its count is pinned above, and there is no tail to identify.
            if tail.segments.is_empty() {
                continue;
            }

            let text_page = page
                .text()
                .map_err(|error| format!("PDFium could not inspect page {page_number}: {error}"))?;
            let mut next = tail.base_objects;

            for segment in &tail.segments {
                for offset in 0..segment.object_count {
                    let object = objects.get(next + offset).map_err(|error| {
                        format!(
                            "PDFium could not inspect owned object {}: {error}",
                            next + offset
                        )
                    })?;
                    let text_object = object.as_text_object().ok_or_else(|| {
                        format!("page {page_number}'s owned tail contains a non-text object")
                    })?;
                    // PDFium's extraction appends a separator to a run another
                    // run follows on the same line, so tiles sharing a baseline
                    // come back as "TEXT " except the last, "TEXT"; the identity
                    // stored at apply was trimmed the same way, so the edges
                    // carry nothing worth comparing.
                    let actual = text_page.for_object(text_object).trim().to_owned();

                    if actual != segment.identities[offset] {
                        return Err(format!(
                            "page {page_number}'s owned tail contains different text"
                        ));
                    }
                }

                next += segment.object_count;
            }
        }

        Ok(())
    }

    /// Reads back the identities of a tail this rebuild just wrote, one string
    /// per object, so a later guard can compare against what PDFium actually
    /// holds — not the source text an embedded font may have remapped.
    fn read_owned_tail(
        document: &PdfDocument<'static>,
        page_number: i32,
        base_objects: usize,
        segment_counts: &[usize],
    ) -> Result<OwnedTailState, String> {
        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let objects = page.objects();
        let text_page = page
            .text()
            .map_err(|error| format!("PDFium could not inspect page {page_number}: {error}"))?;
        let mut segments = Vec::with_capacity(segment_counts.len());
        let mut next = base_objects;

        for &count in segment_counts {
            let mut identities = Vec::with_capacity(count);

            for offset in 0..count {
                let object = objects.get(next + offset).map_err(|error| {
                    format!(
                        "PDFium could not inspect owned object {}: {error}",
                        next + offset
                    )
                })?;
                let text_object = object.as_text_object().ok_or_else(|| {
                    format!("page {page_number}'s owned tail contains a non-text object")
                })?;

                identities.push(text_page.for_object(text_object).trim().to_owned());
            }

            segments.push(OwnedSegment {
                object_count: count,
                identities,
            });
            next += count;
        }

        Ok(OwnedTailState {
            base_objects,
            segments,
        })
    }

    /// Plans every page's rebuild before any is touched, so a measurement or
    /// object-limit failure leaves the document untouched. `base_objects` is
    /// read from the prior owned record when one exists — a replacement rebuilds
    /// the same base — or the page's current object count on a first apply.
    fn plan_owned_content(
        entry: &OpenDocument,
        watermark: Option<(&WatermarkConfig, PdfFontToken, PdfColor)>,
        page_numbers: Option<(&PageNumbersConfig, PdfFontToken)>,
    ) -> Result<Vec<PageOwnedPlan>, String> {
        let page_count = entry.document.pages().len();

        // Without this an empty document takes an empty ownership record, which
        // every later guard passes vacuously — leaving a session that believes
        // it holds marks, and so refuses to save, over nothing at all.
        if page_count < 1 {
            return Err("a document with no pages cannot carry page marks".into());
        }

        let previous = entry.owned_content.as_ref();
        let mut plans = Vec::with_capacity(page_count as usize);
        let mut measured_bounds: Vec<(u32, (f32, f32))> = Vec::new();
        let mut document_objects = 0usize;

        for page_number in 1..=page_count {
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            let base_objects = match previous {
                Some(state) => {
                    state
                        .per_page
                        .get(&entry.page_id(page_number)?)
                        .ok_or_else(|| {
                            format!("the owned-content record is missing page {page_number}")
                        })?
                        .base_objects
                }
                None => page.objects().len(),
            };

            let watermark_plan = match watermark {
                Some((config, font, color)) => {
                    let page_rotation = page_rotation_degrees(&page);
                    let object_rotation = config.rotation - page_rotation;
                    let (page_width, page_height) = unrotated_page_size(&page);
                    // One text at one angle always measures the same, and
                    // `/Rotate` has only four values — so a document of any
                    // length needs at most four of these.
                    let key = object_rotation.to_bits();
                    let (text_width, text_height) =
                        match measured_bounds.iter().find(|(cached, _)| *cached == key) {
                            Some((_, size)) => *size,
                            None => {
                                let measured = rotated_watermark_object(
                                    &entry.document,
                                    font,
                                    config,
                                    color,
                                    object_rotation,
                                )?;
                                let bounds = measured.bounds().map_err(|error| {
                                    format!("PDFium could not measure the watermark: {error}")
                                })?;
                                let size = (
                                    bounds.right().value - bounds.left().value,
                                    bounds.top().value - bounds.bottom().value,
                                );

                                measured_bounds.push((key, size));
                                size
                            }
                        };
                    let placements = watermark_placements(
                        page_width,
                        page_height,
                        text_width,
                        text_height,
                        config,
                    )?;

                    document_objects =
                        add_document_object_count(document_objects, placements.len())?;

                    Some(WatermarkLayerPlan {
                        object_rotation,
                        placements,
                    })
                }
                None => None,
            };

            let page_number_label = match page_numbers {
                Some((config, font)) if config.covers(page_number) => {
                    let page_rotation = page_rotation_degrees(&page);
                    // Page numbers are always upright as the reader sees them,
                    // so the object is turned by exactly the negative of the
                    // page's own `/Rotate`, which a render then puts back.
                    let object_rotation = -page_rotation;
                    let (unrotated_width, unrotated_height) = unrotated_page_size(&page);
                    let text = config.label(page_number);
                    let anchor = config.anchor(page_number);

                    // Measure the label exactly as it will be built, so the
                    // placement and the smart-colour drop both use real bounds
                    // (M3/M6 lesson: measure before positioning).
                    let measured = rotated_page_number_object(
                        &entry.document,
                        font,
                        &text,
                        PdfColor::BLACK,
                        object_rotation,
                    )?;
                    let bounds = measured.bounds().map_err(|error| {
                        format!("PDFium could not measure a page number: {error}")
                    })?;
                    let bounds_width = bounds.right().value - bounds.left().value;
                    let bounds_height = bounds.top().value - bounds.bottom().value;
                    drop(measured);

                    let center = page_number_center(
                        unrotated_width,
                        unrotated_height,
                        page_rotation,
                        bounds_width,
                        bounds_height,
                        anchor,
                    );

                    // The drop is sampled in the rebuild, not here: a replacement
                    // must read the page after its old label is gone, which has
                    // not happened yet at plan time.
                    let sample_box = config.smart_color().then(|| {
                        page_number_display_box(
                            unrotated_width,
                            unrotated_height,
                            page_rotation,
                            bounds_width,
                            bounds_height,
                            anchor,
                        )
                    });

                    Some(PageNumberLayerPlan {
                        text,
                        object_rotation,
                        center,
                        sample_box,
                    })
                }
                _ => None,
            };

            plans.push(PageOwnedPlan {
                base_objects,
                page_number,
                watermark: watermark_plan,
                page_number_label,
            });
        }

        Ok(plans)
    }

    /// Averages the relative luminance of the drop a page number will cover, at
    /// a low sampling resolution, and returns the ink that stays legible on it —
    /// white on a dark drop, black otherwise. A page with no usable dimensions,
    /// or a region that falls outside the render, defaults to black.
    fn sample_ink_color(page: &PdfPage<'_>, region: DisplayBox) -> Result<PdfColor, String> {
        let display_width = page.width().value;
        let display_height = page.height().value;

        if !display_width.is_finite()
            || !display_height.is_finite()
            || display_width <= 0.0
            || display_height <= 0.0
        {
            return Ok(PdfColor::BLACK);
        }

        // Far cheaper than M5's print-resolution capture: the decision is a
        // single average, so a handful of pixels across the label suffices.
        let scale = (PAGE_NUMBER_SAMPLE_DPI / POINTS_PER_INCH)
            .min(MAX_RENDER_WIDTH as f32 / display_width)
            .min(MAX_RENDER_HEIGHT as f32 / display_height);
        let render_width = (display_width * scale)
            .round()
            .clamp(1.0, MAX_RENDER_WIDTH as f32) as i32;
        let config = PdfRenderConfig::new()
            .set_target_width(render_width)
            .set_maximum_width(MAX_RENDER_WIDTH)
            .set_maximum_height(MAX_RENDER_HEIGHT)
            .render_annotations(true)
            .render_form_data(true);
        let rendered = page
            .render_with_config(&config)
            .and_then(|bitmap| bitmap.as_image())
            .map_err(|error| format!("PDFium could not sample a page for smart colour: {error}"))?;

        let scale_x = rendered.width() as f32 / display_width;
        let scale_y = rendered.height() as f32 / display_height;
        let left = ((region.left - PAGE_NUMBER_SAMPLE_PADDING) * scale_x)
            .floor()
            .max(0.0) as u32;
        let top = ((region.top - PAGE_NUMBER_SAMPLE_PADDING) * scale_y)
            .floor()
            .max(0.0) as u32;
        let right = ((region.left + region.width + PAGE_NUMBER_SAMPLE_PADDING) * scale_x)
            .ceil()
            .min(rendered.width() as f32) as u32;
        let bottom = ((region.top + region.height + PAGE_NUMBER_SAMPLE_PADDING) * scale_y)
            .ceil()
            .min(rendered.height() as f32) as u32;

        if right <= left || bottom <= top {
            return Ok(PdfColor::BLACK);
        }

        let crop = rendered
            .crop_imm(left, top, right - left, bottom - top)
            .into_rgba8()
            .into_raw();

        PdfColor::from_hex(ink_color(average_luminance(&crop)))
            .map_err(|error| format!("PDFium rejected the page-number colour: {error}"))
    }

    fn restore_document_snapshot(
        &self,
        entry: &mut OpenDocument,
        snapshot: Vec<u8>,
        cause: String,
    ) -> String {
        match self.pdfium.load_pdf_from_byte_vec(snapshot, None) {
            Ok(document) => {
                entry.document = document;
                cause
            }
            Err(error) => format!(
                "{cause}; PDFium also could not roll the document back to its previous bytes: {error}"
            ),
        }
    }

    /// `pdfium-render` 0.9.3's generic removed-object wrapper would destroy the
    /// same native handle twice if simply dropped. Reattach retired objects to a
    /// temporary page immediately; deleting that page then lets PDFium own the
    /// cleanup. The page exists only inside an apply/remove transaction.
    ///
    /// Attaching is the whole job — the scratch page's content stream is never
    /// read, and it is deleted before the transaction ends. Regenerating it here
    /// would rewrite every object retired so far once per page, which is why the
    /// strategy stays `Manual`: it is also what keeps `PdfPage`'s own drop from
    /// regenerating the page behind us.
    fn retire_owned_objects(
        document: &mut PdfDocument<'static>,
        scratch_index: i32,
        objects: Vec<PdfPageObject<'static>>,
    ) -> Result<(), String> {
        if objects.is_empty() {
            return Ok(());
        }

        let mut scratch = document
            .pages_mut()
            .get(scratch_index)
            .map_err(|error| format!("PDFium could not load the scratch page: {error}"))?;
        scratch.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        for object in objects {
            scratch
                .objects_mut()
                .add_object(object)
                .map_err(|error| format!("PDFium could not retire an old owned object: {error}"))?;
        }

        Ok(())
    }

    /// Rebuilds every page's owned-content tail to match the given active layer
    /// configs, replacing whatever this session previously owned.
    ///
    /// The whole tail is popped and re-appended in the fixed layer order on
    /// every page, so a change to one layer can never leave it stacked wrong
    /// against another — `add_object` only appends, and this is the one path
    /// that keeps the order canonical. A saved byte snapshot makes every
    /// multi-page failure an exact rollback, including one after an earlier page
    /// already regenerated.
    fn rebuild_owned_content(
        &self,
        entry: &mut OpenDocument,
        watermark: Option<WatermarkResources>,
        page_numbers: Option<PageNumbersResources>,
    ) -> Result<(), String> {
        let previous = entry.owned_content.clone();
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        let rebuilt = (|| -> Result<OwnedContentState, String> {
            // Load each active layer's font once, into the document, and thread
            // the token through the per-page loop — a replacement reloads even an
            // unchanged layer's font, since its objects are rebuilt too.
            let watermark_font = match &watermark {
                Some(resources) => Some(match &resources.embedded {
                    Some(bytes) => entry
                        .document
                        .fonts_mut()
                        .load_true_type_from_bytes(bytes, true)
                        .map_err(|error| format!("PDFium rejected the bundled font: {error}"))?,
                    None => {
                        let config = &resources.config;
                        let face = standard_face(config.font_family.as_str())
                            .expect("WatermarkFontFamily only has standard-face variants");
                        let fonts = entry.document.fonts_mut();

                        match (face, config.bold) {
                            (StandardFace::Sans, false) => fonts.helvetica(),
                            (StandardFace::Sans, true) => fonts.helvetica_bold(),
                            (StandardFace::Serif, false) => fonts.times_roman(),
                            (StandardFace::Serif, true) => fonts.times_bold(),
                            (StandardFace::Mono, false) => fonts.courier(),
                            (StandardFace::Mono, true) => fonts.courier_bold(),
                        }
                    }
                }),
                None => None,
            };
            let page_number_font = match &page_numbers {
                Some(resources) => Some(
                    entry
                        .document
                        .fonts_mut()
                        .load_true_type_from_bytes(&resources.serif, true)
                        .map_err(|error| {
                            format!("PDFium rejected the bundled serif font: {error}")
                        })?,
                ),
                None => None,
            };

            let plans = Self::plan_owned_content(
                entry,
                watermark
                    .as_ref()
                    .map(|resources| (&resources.config, watermark_font.unwrap(), resources.color)),
                page_numbers
                    .as_ref()
                    .map(|resources| (&resources.config, page_number_font.unwrap())),
            )?;

            // A scratch page receives every retired object; created only when
            // there is a prior tail to pop, and deleted before the transaction
            // ends so PDFium collects the retired handles.
            let scratch_index = if previous.is_some() {
                let index = entry.document.pages().len();
                let scratch = entry
                    .document
                    .pages_mut()
                    .create_page_at_end(PdfPagePaperSize::a4())
                    .map_err(|error| format!("PDFium could not create a scratch page: {error}"))?;
                drop(scratch);
                Some(index)
            } else {
                None
            };

            let mut per_page = HashMap::with_capacity(plans.len());

            for plan in plans {
                let page_id = entry.page_id(plan.page_number)?;

                // Build the watermark objects up front — a font or placement
                // failure then leaves the page untouched. The page-number object
                // is built later, once the drop it sits on can be sampled.
                let mut watermark_objects: Vec<PdfPageTextObject<'static>> = Vec::new();
                if let Some(layer) = &plan.watermark {
                    let resources = watermark
                        .as_ref()
                        .expect("a watermark plan implies watermark resources");
                    let font = watermark_font.expect("a watermark plan implies a loaded font");
                    watermark_objects.reserve(layer.placements.len());

                    for placement in &layer.placements {
                        let object = rotated_watermark_object(
                            &entry.document,
                            font,
                            &resources.config,
                            resources.color,
                            layer.object_rotation,
                        )?;
                        watermark_objects.push(place_text_object(
                            object,
                            placement.center_x,
                            placement.center_y,
                        )?);
                    }
                }

                let previous_tail = previous
                    .as_ref()
                    .and_then(|state| state.per_page.get(&page_id))
                    .map(OwnedTailState::owned_objects)
                    .unwrap_or(0);

                let mut retired = Vec::new();
                let mut change_error = None;
                let mut changed = false;

                // First pass: pop the previous owned tail and lay down the
                // watermark beneath. A smart-colour page regenerates here, so the
                // sample below reads the real backdrop — the new watermark now
                // under the number — and never the old label the pop just lifted.
                {
                    let mut page = entry
                        .document
                        .pages_mut()
                        .get(plan.page_number - 1)
                        .map_err(|error| {
                            format!("PDFium could not load page {}: {error}", plan.page_number)
                        })?;
                    page.set_content_regeneration_strategy(
                        PdfPageContentRegenerationStrategy::Manual,
                    );

                    {
                        let objects = page.objects_mut();

                        for _ in 0..previous_tail {
                            let Some(last) = objects.len().checked_sub(1) else {
                                change_error =
                                    Some("the owned tail disappeared during a rebuild".to_string());
                                break;
                            };

                            match objects.remove_object_at_index(last) {
                                Ok(object) => {
                                    retired.push(object);
                                    changed = true;
                                }
                                Err(error) => {
                                    change_error = Some(format!(
                                        "PDFium could not remove the old owned content: {error}"
                                    ));
                                    break;
                                }
                            }
                        }
                    }

                    if change_error.is_none() {
                        for object in watermark_objects {
                            match page.objects_mut().add_text_object(object) {
                                Ok(_) => changed = true,
                                Err(error) => {
                                    change_error = Some(format!(
                                        "PDFium could not append the watermark: {error}"
                                    ));
                                    break;
                                }
                            }
                        }
                    }

                    // Regenerate before the handle closes whenever this pass
                    // changed the page — PDFium drops objects that were inserted
                    // but never flushed once the page is reopened for the second
                    // pass. A first-apply page-numbers-only page pops nothing and
                    // lays no watermark, so `changed` stays false and its flush
                    // falls to the second pass; every other case flushes here so
                    // the smart-colour sample below reads a persisted backdrop.
                    if changed && change_error.is_none() {
                        if let Err(error) = page.regenerate_content() {
                            change_error =
                                Some(format!("PDFium could not regenerate the page: {error}"));
                        }
                    }
                    page.set_content_regeneration_strategy(
                        PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
                    );
                }

                // Choose the page number's ink from the drop it now sits on —
                // sampled after the pop, so a replacement never reads its own old
                // label — then build the object.
                let page_number_object = if change_error.is_none() {
                    match &plan.page_number_label {
                        Some(layer) => {
                            let color = match layer.sample_box {
                                Some(region) => {
                                    let page =
                                        entry.document.pages().get(plan.page_number - 1).map_err(
                                            |error| {
                                                format!(
                                                    "PDFium could not load page {}: {error}",
                                                    plan.page_number
                                                )
                                            },
                                        )?;

                                    Self::sample_ink_color(&page, region)?
                                }
                                None => PdfColor::BLACK,
                            };
                            let font =
                                page_number_font.expect("a page-number plan implies a loaded font");
                            let object = rotated_page_number_object(
                                &entry.document,
                                font,
                                &layer.text,
                                color,
                                layer.object_rotation,
                            )?;

                            Some(place_text_object(
                                object,
                                layer.center.center_x,
                                layer.center.center_y,
                            )?)
                        }
                        None => None,
                    }
                } else {
                    None
                };

                // Second pass: lay the page number over the flushed watermark. The
                // first pass already persisted the pop and the watermark, so a
                // page with no number needs no second pass at all.
                if let Some(object) = page_number_object {
                    let mut page = entry
                        .document
                        .pages_mut()
                        .get(plan.page_number - 1)
                        .map_err(|error| {
                            format!("PDFium could not load page {}: {error}", plan.page_number)
                        })?;
                    page.set_content_regeneration_strategy(
                        PdfPageContentRegenerationStrategy::Manual,
                    );

                    match page.objects_mut().add_text_object(object) {
                        Ok(_) => {
                            if let Err(error) = page.regenerate_content() {
                                change_error =
                                    Some(format!("PDFium could not regenerate the page: {error}"));
                            }
                        }
                        Err(error) => {
                            change_error =
                                Some(format!("PDFium could not append the page number: {error}"));
                        }
                    }
                    page.set_content_regeneration_strategy(
                        PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
                    );
                }

                if let Some(index) = scratch_index {
                    if let Err(error) =
                        Self::retire_owned_objects(&mut entry.document, index, retired)
                    {
                        change_error.get_or_insert(error);
                    }
                }
                if let Some(error) = change_error {
                    return Err(error);
                }

                // The tail's segments, in the order they were appended: watermark
                // beneath, page number above.
                let mut segment_counts = Vec::new();
                if let Some(layer) = &plan.watermark {
                    segment_counts.push(layer.placements.len());
                }
                if plan.page_number_label.is_some() {
                    segment_counts.push(1);
                }

                let tail = Self::read_owned_tail(
                    &entry.document,
                    plan.page_number,
                    plan.base_objects,
                    &segment_counts,
                )?;

                per_page.insert(page_id, tail);
            }

            if let Some(index) = scratch_index {
                entry
                    .document
                    .pages_mut()
                    .get(index)
                    .map_err(|error| format!("PDFium could not load the scratch page: {error}"))?
                    .delete()
                    .map_err(|error| {
                        format!("PDFium could not delete the scratch page: {error}")
                    })?;
            }

            Ok(OwnedContentState {
                watermark: watermark.as_ref().map(|resources| resources.config.clone()),
                page_numbers: page_numbers
                    .as_ref()
                    .map(|resources| resources.config.clone()),
                per_page,
            })
        })();

        let state = match rebuilt {
            Ok(state) => state,
            Err(error) => {
                return Err(self.restore_document_snapshot(entry, snapshot, error));
            }
        };

        // A rebuild that had something to pop leaves orphaned fonts and content
        // behind for the next save to collect; a first apply removes nothing.
        entry.needs_compaction |= previous.is_some();
        entry.owned_content = if state.has_active_layer() {
            Some(state)
        } else {
            None
        };
        entry.invalidate_all_page_revisions();

        Ok(())
    }

    /// The watermark layer's rebuild inputs from a stored config: its resolved
    /// colour and, for embedded text, the bundled face subset. The subset is the
    /// expensive part, so a *new* watermark's resources are prepared outside the
    /// lock; an existing layer's — rebuilt to survive a change to the other —
    /// are prepared under it, from a config that cannot change while it is held.
    fn watermark_resources(&self, config: &WatermarkConfig) -> Result<WatermarkResources, String> {
        let color = PdfColor::from_hex(&config.color)
            .map_err(|error| format!("the watermark colour is unusable: {error}"))?
            .with_alpha((config.opacity * 255.0).round() as u8);
        let embedded = if needs_embedded_font(&config.text) {
            let font = if config.bold {
                self.cjk_bold_font_bytes()?
            } else {
                self.cjk_font_bytes()?
            };

            Some(subset_for(font, &config.text)?)
        } else {
            None
        };

        Ok(WatermarkResources {
            config: config.clone(),
            color,
            embedded,
        })
    }

    /// The page-number layer's rebuild inputs from a stored config: the bundled
    /// serif bytes, which are kilobytes and cached, so this is cheap enough to
    /// run under the lock.
    fn page_numbers_resources(
        &self,
        config: &PageNumbersConfig,
    ) -> Result<PageNumbersResources, String> {
        Ok(PageNumbersResources {
            config: config.clone(),
            serif: self.serif_cjk_font_bytes()?.to_vec(),
        })
    }

    /// The page-number layer's resources rebuilt from the document's current
    /// config, or `None` if it carries no page numbers — what a watermark change
    /// passes so the other layer survives it unchanged.
    fn existing_page_numbers(
        &self,
        entry: &OpenDocument,
    ) -> Result<Option<PageNumbersResources>, String> {
        match entry
            .owned_content
            .as_ref()
            .and_then(|state| state.page_numbers.clone())
        {
            Some(config) => Ok(Some(self.page_numbers_resources(&config)?)),
            None => Ok(None),
        }
    }

    /// The watermark layer's resources rebuilt from the document's current
    /// config, or `None` — what a page-number change passes so the watermark
    /// survives it unchanged.
    fn existing_watermark(
        &self,
        entry: &OpenDocument,
    ) -> Result<Option<WatermarkResources>, String> {
        match entry
            .owned_content
            .as_ref()
            .and_then(|state| state.watermark.clone())
        {
            Some(config) => Ok(Some(self.watermark_resources(&config)?)),
            None => Ok(None),
        }
    }

    /// Applies a new document-wide watermark, replacing the one this open
    /// session owns and rebuilding every owned layer's tail in canonical order.
    pub(super) fn apply_watermark(
        &self,
        document_id: u64,
        config: WatermarkConfig,
    ) -> Result<(), String> {
        let config = config.validated()?;

        // Avoid a 17 MB read and subset for an exact no-op, while still checking
        // again under the commit lock in case another direct IPC raced this one.
        {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;

            if entry
                .owned_content
                .as_ref()
                .is_some_and(|state| state.watermark.as_ref() == Some(&config))
            {
                return Ok(());
            }
        }

        // Prepared without the PDFium lock because cutting the bundled face is
        // pure CPU work; the whole document reuses this one subset.
        let watermark = self.watermark_resources(&config)?;

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        if entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.watermark.as_ref() == Some(&config))
        {
            return Ok(());
        }
        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&entry.document, &entry.page_ids, state)?;
        }

        let page_numbers = self.existing_page_numbers(entry)?;

        self.rebuild_owned_content(entry, Some(watermark), page_numbers)
    }

    /// Removes only the watermark this open session owns, rebuilding any other
    /// owned layer's tail so it survives the change unaltered.
    pub(super) fn remove_watermark(&self, document_id: u64) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        if !entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.watermark.is_some())
        {
            return Err("this session has no watermark to remove".into());
        }
        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&entry.document, &entry.page_ids, state)?;
        }

        let page_numbers = self.existing_page_numbers(entry)?;

        self.rebuild_owned_content(entry, None, page_numbers)
    }

    /// Applies page numbers, replacing the ones this open session owns and
    /// rebuilding every owned layer's tail in canonical order — the page numbers
    /// on top. The range is validated against the document's current length.
    pub(super) fn apply_page_numbers(
        &self,
        document_id: u64,
        config: PageNumbersConfig,
    ) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let config = config.validated(entry.page_ids.len() as i32)?;

        // Checked before any work, so an unchanged config never rebuilds an
        // existing watermark's font. A single lock leaves no window for a
        // concurrent IPC to slip between the check and the rebuild.
        if entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.page_numbers.as_ref() == Some(&config))
        {
            return Ok(());
        }
        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&entry.document, &entry.page_ids, state)?;
        }

        // The other layer is rebuilt from its current config; its subset is
        // taken under the lock, which the plan accepts as the cost of stacking a
        // second layer on a watermarked document.
        let watermark = self.existing_watermark(entry)?;
        let page_numbers = self.page_numbers_resources(&config)?;

        self.rebuild_owned_content(entry, watermark, Some(page_numbers))
    }

    /// Removes only the page numbers this open session owns, rebuilding any
    /// watermark so it survives the change unaltered.
    pub(super) fn remove_page_numbers(&self, document_id: u64) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        if !entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.page_numbers.is_some())
        {
            return Err("this session has no page numbers to remove".into());
        }
        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&entry.document, &entry.page_ids, state)?;
        }

        let watermark = self.existing_watermark(entry)?;

        self.rebuild_owned_content(entry, watermark, None)
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
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

        if entry.added.get(&page_id).copied().unwrap_or(0) == 0 {
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

        if let Some(added) = entry.added.get_mut(&page_id) {
            *added -= 1;
        }
        *entry.revisions.entry(page_id).or_insert(0) += 1;
        entry.needs_compaction = true;

        Ok(())
    }

    /// Rearranges the pages into `order` — the current 1-based page numbers in
    /// their new sequence. The identity order changes nothing and bumps nothing.
    pub(super) fn reorder_pages(
        &self,
        document_id: u64,
        order: &[i32],
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let Some(indices) = validate_page_order(order, entry.page_ids.len())? else {
            return Ok(document_layout(&entry.document));
        };

        // A failed FPDF_MovePages may leave the document in an indeterminate
        // state, so even a pure move takes the M6 snapshot precaution.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        if let Err(error) = entry.document.pages_mut().move_pages(&indices, 0) {
            return Err(self.restore_document_snapshot(
                entry,
                snapshot,
                format!("PDFium could not reorder the pages: {error}"),
            ));
        }

        entry.page_ids = indices
            .iter()
            .map(|index| entry.page_ids[*index as usize])
            .collect();

        // Every page's content now sits at a new position, so an effect
        // captured before the move must fail its revision check after it.
        entry.invalidate_all_page_revisions();

        Ok(document_layout(&entry.document))
    }

    /// Deletes the given pages, first copying them — and the session state
    /// riding with them — into a stash under `stash_id` for a later restore.
    /// An occupied `stash_id` is replaced: the key names one history entry,
    /// and a redo of that entry's delete stashes the same logical pages again.
    pub(super) fn delete_pages(
        &self,
        document_id: u64,
        page_numbers: &[i32],
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let indices = validate_pages_to_delete(page_numbers, entry.page_ids.len())?;

        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        let stashed = (|| -> Result<PdfDocument<'static>, String> {
            let mut stash_document = self
                .pdfium
                .create_new_pdf()
                .map_err(|error| format!("PDFium could not prepare the page stash: {error}"))?;
            let range = indices
                .iter()
                .map(|index| (index + 1).to_string())
                .collect::<Vec<_>>()
                .join(",");

            stash_document
                .pages_mut()
                .copy_pages_from_document(&entry.document, &range, 0)
                .map_err(|error| format!("PDFium could not copy the pages aside: {error}"))?;

            // Descending, so each deletion leaves the shallower indices true.
            for index in indices.iter().rev() {
                entry
                    .document
                    .pages_mut()
                    .get(*index as i32)
                    .map_err(|error| format!("PDFium could not load page {}: {error}", index + 1))?
                    .delete()
                    .map_err(|error| {
                        format!("PDFium could not delete page {}: {error}", index + 1)
                    })?;
            }

            Ok(stash_document)
        })();
        let stash_document = match stashed {
            Ok(document) => document,
            Err(error) => return Err(self.restore_document_snapshot(entry, snapshot, error)),
        };

        // PDFium is done; move each page's session state into the stash.
        let mut pages = Vec::with_capacity(indices.len());

        for index in indices.iter().rev() {
            let page_id = entry.page_ids.remove(*index);

            pages.push(StashedPage {
                position: *index as i32 + 1,
                page_id,
                added: entry.added.remove(&page_id).unwrap_or(0),
                revision: entry.revisions.remove(&page_id).unwrap_or(0),
                owned: entry
                    .owned_content
                    .as_mut()
                    .and_then(|state| state.per_page.remove(&page_id)),
                // A deleted merged page leaves the document; the guard follows.
                merged: entry.merged_page_ids.remove(&page_id),
            });
        }
        // Ascending — the order their copies sit in the stash document.
        pages.reverse();

        entry.stashes.insert(
            stash_id,
            PageStash {
                document: stash_document,
                pages,
            },
        );
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(document_layout(&entry.document))
    }

    /// Puts a stash's pages back where they were deleted from, consuming it.
    pub(super) fn restore_pages(
        &self,
        document_id: u64,
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let Some(stash) = entry.stashes.remove(&stash_id) else {
            return Err("there are no stashed pages under this undo entry".into());
        };

        // LIFO undo has the document back in its post-delete shape, but the
        // caller is a browser: prove every recorded position fits before
        // touching PDFium. Ascending insertion counts the pages already back.
        let fits = stash.pages.iter().enumerate().all(|(offset, stashed)| {
            stashed.position >= 1 && stashed.position as usize <= entry.page_ids.len() + offset + 1
        });

        if !fits {
            entry.stashes.insert(stash_id, stash);
            return Err("the stashed pages do not fit this document".into());
        }

        let snapshot = match entry.document.save_to_bytes() {
            Ok(bytes) => bytes,
            Err(error) => {
                entry.stashes.insert(stash_id, stash);
                return Err(format!("PDFium could not snapshot the document: {error}"));
            }
        };
        let restored = (|| -> Result<(), String> {
            for (offset, stashed) in stash.pages.iter().enumerate() {
                entry
                    .document
                    .pages_mut()
                    .copy_page_from_document(&stash.document, offset as i32, stashed.position - 1)
                    .map_err(|error| {
                        format!(
                            "PDFium could not restore page {}: {error}",
                            stashed.position
                        )
                    })?;
            }

            Ok(())
        })();

        if let Err(error) = restored {
            let cause = self.restore_document_snapshot(entry, snapshot, error);

            entry.stashes.insert(stash_id, stash);
            return Err(cause);
        }

        let mut next_page_ids = entry.page_ids.clone();

        for stashed in &stash.pages {
            next_page_ids.insert(stashed.position as usize - 1, stashed.page_id);
        }

        // The copies came back through FPDF_ImportPages; prove every owned
        // layer's tail survived the round trip before accepting the document,
        // as M6's compaction does after its own save-and-reload.
        if let Some(state) = &entry.owned_content {
            let mut prospective = state.clone();

            for stashed in &stash.pages {
                if let Some(tail) = &stashed.owned {
                    prospective.per_page.insert(stashed.page_id, tail.clone());
                }
            }

            if let Err(error) =
                Self::verify_owned_tail(&entry.document, &next_page_ids, &prospective)
            {
                let cause = self.restore_document_snapshot(
                    entry,
                    snapshot,
                    format!("the restored pages no longer carry this session's marks: {error}"),
                );

                entry.stashes.insert(stash_id, stash);
                return Err(cause);
            }

            entry.owned_content = Some(prospective);
        }

        entry.page_ids = next_page_ids;
        for stashed in &stash.pages {
            if stashed.added > 0 {
                entry.added.insert(stashed.page_id, stashed.added);
            }

            if stashed.merged {
                entry.merged_page_ids.insert(stashed.page_id);
            }

            entry.revisions.insert(stashed.page_id, stashed.revision);
        }

        // The delete already set this, and the import may leave orphans of its
        // own; keep the next write on the compacting path either way.
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(document_layout(&entry.document))
    }

    /// Inserts a blank page at 1-based `index`, sized from the unrotated
    /// dimensions of the page that will follow it — or precede it, at the end.
    pub(super) fn insert_blank_page(
        &self,
        document_id: u64,
        index: i32,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_count = entry.page_ids.len();
        // One past the end is a position too, so the check is page_index's
        // with the count stretched by one.
        let Some(slot) = page_index(index, page_count + 1) else {
            return Err(format!("a page cannot go to position {index}"));
        };

        // The size is read off the neighbour under the lock, never taken from
        // the WebView.
        let neighbor_index = slot.min(page_count.saturating_sub(1));
        let (width, height) = {
            let page = entry
                .document
                .pages()
                .get(neighbor_index as i32)
                .map_err(|error| {
                    format!("PDFium could not load page {}: {error}", neighbor_index + 1)
                })?;

            unrotated_page_size(&page)
        };
        let page = entry
            .document
            .pages_mut()
            .create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(width), PdfPoints::new(height)),
                slot as i32,
            )
            .map_err(|error| format!("PDFium could not create the blank page: {error}"))?;

        drop(page);

        let page_id = entry.next_page_id;

        entry.next_page_id += 1;
        entry.page_ids.insert(slot, page_id);

        if let Some(state) = entry.owned_content.as_mut() {
            // Owned but bare: no active layer covers a blank page inserted after
            // it was applied, and only a re-apply will. A blank page has no
            // content of its own, so its base is zero.
            state.per_page.insert(
                page_id,
                OwnedTailState {
                    base_objects: 0,
                    segments: Vec::new(),
                },
            );
        }

        entry.invalidate_all_page_revisions();

        Ok(document_layout(&entry.document))
    }

    /// Appends every page of the PDF at `path` to the end of the open document,
    /// as one merge. The source is opened under the same limits as a fresh open
    /// and never enters the document store; a "file" in the merged document is
    /// only the frontend's accounting of a page range, not a second document.
    pub(super) fn merge_from_path(
        &self,
        document_id: u64,
        path: PathBuf,
    ) -> Result<MergeOutcome, String> {
        // Sized before it is read, like `open_from_path`: a merge honours the
        // same MiB ceiling as an open, and reading the metadata first keeps an
        // oversized file from being pulled wholesale into memory.
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

        if bytes.is_empty() {
            return Err("PDF file is empty".into());
        }

        if bytes.len() > MAX_PDF_BYTES {
            return Err(size_limit_error());
        }

        let mut documents = self.lock_documents()?;
        // The source is opened inside the lock — loading a PDF is PDFium work —
        // and dropped when this scope ends, never inserted into the store. Its
        // error wording matches `open`'s, so an encrypted file is refused the
        // same way whichever door it comes through.
        let source = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not open the document: {error}"))?;
        let added_count = source.pages().len();

        if added_count < 1 {
            return Err("the merged PDF has no pages".into());
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        let inserted_at = entry.page_ids.len() as i32 + 1;

        // Append imports the pages, which may fail partway; snapshot first so a
        // failure rolls the document back whole, as every multi-page structure
        // change does.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        if let Err(error) = entry.document.pages_mut().append(&source) {
            return Err(self.restore_document_snapshot(
                entry,
                snapshot,
                format!("PDFium could not merge the document: {error}"),
            ));
        }

        // A merged page carries its source's own content objects. When this
        // session owns any layer, each new page takes an owned-but-bare record
        // whose base is that content and whose tail is empty — no active layer
        // covers a page it never marked. Measured before the recording loop,
        // which needs a mutable borrow of the same entry.
        //
        // A read failure here rolls the append back like `append` itself does:
        // the pages are already on the document, so a bare `?` would leave them
        // there while `page_ids` never learned of them — a desync every later
        // command trusts against.
        let new_base_objects = match &entry.owned_content {
            Some(_) => {
                let measured = (0..added_count)
                    .map(|offset| {
                        let index = inserted_at - 1 + offset;
                        entry
                            .document
                            .pages()
                            .get(index)
                            .map(|page| page.objects().len())
                            .map_err(|error| {
                                format!(
                                    "PDFium could not inspect merged page {}: {error}",
                                    index + 1
                                )
                            })
                    })
                    .collect::<Result<Vec<_>, _>>();

                match measured {
                    Ok(values) => values,
                    Err(error) => {
                        return Err(self.restore_document_snapshot(entry, snapshot, error));
                    }
                }
            }
            None => Vec::new(),
        };

        for offset in 0..added_count {
            let page_id = entry.next_page_id;

            entry.next_page_id += 1;
            entry.page_ids.push(page_id);
            // This page is another file's content: while it stays, the document
            // may only be exported as a copy, not saved over the first file.
            entry.merged_page_ids.insert(page_id);

            if let Some(state) = entry.owned_content.as_mut() {
                // Owned but bare: its base is the source file's own content, and
                // no active layer covers a page it never marked.
                state.per_page.insert(
                    page_id,
                    OwnedTailState {
                        base_objects: new_base_objects[offset as usize],
                        segments: Vec::new(),
                    },
                );
            }
        }

        // Nothing was removed, so no compaction is owed; but every page's
        // content now sits in a longer document, and an M5 effect captured
        // before the merge must fail its revision check after it.
        entry.invalidate_all_page_revisions();

        Ok(MergeOutcome {
            inserted_at,
            page_count: added_count,
            update: document_layout(&entry.document),
        })
    }

    /// Writes the document back over the file it was opened from.
    pub(super) fn save(&self, document_id: u64) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // Ownership of a page-content layer ends when the document closes, so
        // writing one over the reader's own file leaves them a mark this app can
        // no longer lift. A copy is the only destination it may reach. Checked
        // here rather than trusted to the disabled key: the WebView can call the
        // command.
        if entry
            .owned_content
            .as_ref()
            .is_some_and(OwnedContentState::has_active_layer)
        {
            return Err(
                "a document with a watermark or page numbers may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

        // Merged-in pages carry the same restriction as a watermark, for the
        // same reason the plan modelled on it: a save here would write another
        // file's pages over the first file. Enforced in the command, not trusted
        // to the disabled key, since the WebView can call this directly.
        if !entry.merged_page_ids.is_empty() {
            return Err(
                "a document that merged other files may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

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
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // The same refusal `save` makes, at the other exit: a reader who picks
        // their own file in the export dialog would otherwise overwrite it with
        // content this app cannot lift — a watermark, or another file's merged-in
        // pages, both export-only for the same reason. Unlike the
        // `saved_to_source` comparison below, this one resolves aliases before it
        // answers — the two run in opposite directions. Missing a symlinked twin
        // there only leaves the history dirty; missing one here destroys the
        // original.
        if (entry
            .owned_content
            .as_ref()
            .is_some_and(OwnedContentState::has_active_layer)
            || !entry.merged_page_ids.is_empty())
            && entry
                .source_path
                .as_deref()
                .is_some_and(|source| same_file(source, path))
        {
            return Err(
                "this document may only be exported as a copy, not written back over its own file"
                    .into(),
            );
        }

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
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        self.write_document(entry, path)
    }

    /// Reloads the document off its own saved bytes when this session has
    /// deleted an annotation or page object, dropping whatever the removed
    /// content left behind — PDFium collects unreferenced objects on a load,
    /// and only there.
    ///
    /// Costs a whole extra copy of the document in memory while it runs, which
    /// is why it waits for a deletion instead of riding every save. The owned
    /// content is checked before the replacement is accepted: annotation order
    /// is preserved by PDFium, and every owned layer's top-level text objects
    /// must still have the same exact count, order, type, and text.
    fn collect_orphans(&self, entry: &mut OpenDocument) -> Result<(), String> {
        if !entry.needs_compaction {
            return Ok(());
        }

        let bytes = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;

        let reloaded = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reload the document: {error}"))?;

        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&reloaded, &entry.page_ids, state).map_err(|error| {
                format!("PDFium did not preserve the owned content during compaction: {error}")
            })?;
        }

        entry.document = reloaded;
        entry.needs_compaction = false;

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
        self.lock_documents()?.remove(&document_id);

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

/// Whether two paths name one file, following symlinks and `..` as far as the
/// filesystem will resolve them. A destination that does not exist yet — what a
/// save dialog usually names — resolves through its parent instead, so a fresh
/// name inside a symlinked directory still matches. An unresolvable path falls
/// back to a literal comparison, which errs towards "different": the callers
/// that need certainty are the ones asking whether a write would land on a file
/// they already hold, and a path they cannot resolve is not that file.
fn same_file(left: &Path, right: &Path) -> bool {
    fn resolved(path: &Path) -> PathBuf {
        if let Ok(canonical) = path.canonicalize() {
            return canonical;
        }

        match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => match parent.canonicalize() {
                Ok(parent) => parent.join(name),
                Err(_) => path.to_path_buf(),
            },
            _ => path.to_path_buf(),
        }
    }

    resolved(left) == resolved(right)
}

/// The page list and outline as they stand: what an open reports, and what
/// every structure command returns fresh — the frontend holds no mirror of
/// the page list to patch, only this to replace.
fn document_layout(document: &PdfDocument<'static>) -> PdfStructureUpdate {
    let pages = document.pages();

    PdfStructureUpdate {
        num_pages: pages.len(),
        pages: pages
            .iter()
            .map(|page| PdfPageInfo {
                width: page.width().value,
                height: page.height().value,
                rotation: page_rotation_degrees(&page),
            })
            .collect(),
        outline: collect_bookmark_siblings(document.bookmarks().root()),
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

#[cfg(test)]
mod tests;
