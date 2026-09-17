use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
};

use image::{imageops, metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat};
use pdfium_render::prelude::*;
use tauri::AppHandle;

use super::{
    font::{
        fallback_font_candidates, needs_embedded_font, page_number_face, regular_face, subset_for,
        system_embedded_face, EMBEDDED_FACE_PROBE, FONT_MISSING_ERROR, PAGE_NUMBER_GLYPHS,
    },
    geometry::{
        a4_placement, annotation_color, annotation_covers, page_rect_to_pdfium,
        page_rotation_degrees, quad_points_from_rect, union_rect, unrotated_page_height,
        unrotated_page_size, within_page_range, A4_LONG_POINTS, A4_SHORT_POINTS,
        MAX_RECT_EFFECT_STRENGTH, MAX_TEXT_NOTE_CHARS, MAX_TEXT_NOTE_FONT_SIZE,
        MAX_TEXT_NOTE_LINES, MIN_RECT_EFFECT_STRENGTH, MIN_RECT_OPACITY, MIN_TEXT_NOTE_FONT_SIZE,
        MIN_TEXT_NOTE_OPACITY, TEXT_NOTE_BOUNDS_MARGIN, TEXT_NOTE_LINE_HEIGHT,
    },
    library::bind_pdfium,
    outline::{self, OutlineNode},
    page_numbers::{
        average_luminance, blank_scan_box, ink_color, is_blank_sample, page_number_center,
        page_number_display_box, DisplayBox, PageNumberPlacement, PageNumbering, PageNumbersConfig,
        FONT_SIZE as PAGE_NUMBER_FONT_SIZE,
    },
    size_limit_error,
    watermark::{
        add_document_object_count, watermark_font_size, watermark_placements, watermark_rotation,
        watermark_zebra_spacing, WatermarkConfig, WatermarkPlacement, WATERMARK_COLOR,
        WATERMARK_OPACITY, WATERMARK_REFERENCE_FONT_SIZE,
    },
    ExportOutcome, InsertOutcome, MergeBookmarks, MergeSourceError, MergeSourceKind, PagePoint,
    PagePointsRect, PdfDocumentInfo, PdfFileSummary, PdfOutlineItem, PdfPageInfo, PdfSearchMatch,
    PdfSearchOutcome, PdfStructureUpdate, PdfTextSpan, RectEffect, RectEffectKind, RectStyle,
    TextNoteStyle, MAX_PDF_BYTES,
};

pub(super) const POINTS_PER_INCH: f32 = 72.0;

const MIN_RENDER_WIDTH: i32 = 64;
const MAX_RENDER_WIDTH: i32 = 4096;
const MAX_RENDER_HEIGHT: i32 = 4096;
// Thumbnails are decorative navigation targets, never read at full size, so they
// get a much tighter ceiling than a full page render.
const MAX_THUMBNAIL_WIDTH: i32 = 512;
// Each quad is a PDFium call made under the lock every render waits on, and no
// page has this many runs of text.
const MAX_HIGHLIGHT_QUADS: usize = 8192;
// A search term arrives from the WebView and becomes a UTF-16 allocation in
// PDFium, so bound it first; this length is already far past a useful query.
const MAX_SEARCH_CHARS: usize = 256;
// Bound what one IPC response and the WebView's highlight map can retain. The
// separate rectangle ceiling covers pathological wrapped occurrences too.
const MAX_SEARCH_MATCHES: usize = 10_000;
const MAX_SEARCH_RECTS: usize = 50_000;
// Matched on the extension because the wizard must sort a dropped file before
// anything reads it; the bytes are still header-checked when decoded.
pub(super) const MERGE_IMAGE_EXTENSIONS: [&str; 8] =
    ["bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp"];

#[derive(Debug, PartialEq)]
struct DisplayRect {
    height: f32,
    left: f32,
    top: f32,
    width: f32,
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

struct OpenDocument {
    document: PdfDocument<'static>,
    /// Position -> stable page id. Ids are never reused within a session,
    /// which is what lets every id-keyed map below survive structure operations.
    page_ids: Vec<u64>,
    next_page_id: u64,
    /// Geometry memo keyed by stable id — otherwise an `FPDF_LoadPage` per page
    /// on every edit. Rotation retires an entry; a deleted page's survives undo.
    page_geometry: HashMap<u64, PdfPageInfo>,
    /// Deleted pages awaiting undo, keyed by their history entry; an occupied
    /// key is replaced, a redo of that entry stashing the same logical pages.
    stashes: HashMap<u64, PageStash>,
    /// Per page, this session's mark ids in annotation order. PDFium appends,
    /// so they form the annotation tail; a removal must never reach past it.
    marks: HashMap<u64, Vec<u64>>,
    /// Ids for the marks above, never reused within a session, so an id the
    /// frontend still holds cannot come to name a different mark.
    next_mark_id: u64,
    /// Monotonic per-page version: rectangle effects release the PDFium lock
    /// while processing pixels, and this detects a page that changed meanwhile.
    revisions: HashMap<u64, u64>,
    /// The current revision's whole-document serialization length, memoized
    /// for the compress estimates: a rasterized one re-asks on every slider
    /// settle, and the rewrite it measures with is the expensive half. Retired
    /// by every content change, alongside the page revision it bumps.
    serialized_len: Option<u64>,
    /// Page ids inserted from another file and still present: while any remain
    /// the document holds another file's pages, so it may only export to a copy.
    merged_page_ids: HashSet<u64>,
    /// The file a save writes back over; `None` for opened-from-bytes, whose
    /// first export adopts its destination as the source.
    source_path: Option<PathBuf>,
    /// Set by a deletion: PDFium leaves the removed content's references behind
    /// until a save-and-reload collects them, so the next write takes that route.
    needs_compaction: bool,
    owned_content: Option<OwnedContentState>,
}

impl OpenDocument {
    /// Resolves a 1-based page number to its stable id; doubles as the
    /// page-number validation every command needs.
    fn page_id(&self, page_number: i32) -> Result<u64, String> {
        page_index(page_number, self.page_ids.len())
            .map(|index| self.page_ids[index])
            .ok_or_else(|| format!("page {page_number} does not exist"))
    }

    fn record_mark(&mut self, page_id: u64) -> u64 {
        let mark_id = self.next_mark_id;

        self.next_mark_id += 1;
        self.marks.entry(page_id).or_default().push(mark_id);
        self.bump_page_revision(page_id);

        mark_id
    }

    /// A mark's page id, 1-based number, and tail position; an id the session
    /// never made has no place, which refuses one the WebView made up.
    fn locate_mark(&self, mark_id: u64) -> Result<(u64, i32, usize), String> {
        self.page_ids
            .iter()
            .enumerate()
            .find_map(|(index, page_id)| {
                let position = self
                    .marks
                    .get(page_id)?
                    .iter()
                    .position(|id| *id == mark_id)?;

                Some((*page_id, index as i32 + 1, position))
            })
            .ok_or_else(|| format!("mark {mark_id} is not one of this session's"))
    }

    /// Bumps a page's revision, retiring the memoized serialization length
    /// with it: content changed, so the document it measured is gone.
    fn bump_page_revision(&mut self, page_id: u64) {
        *self.revisions.entry(page_id).or_insert(0) += 1;
        self.serialized_len = None;
    }

    /// Bumps every page's revision so an effect captured before a structure
    /// change fails its check: no capture survives a permuted page list.
    fn invalidate_all_page_revisions(&mut self) {
        for &page_id in &self.page_ids {
            *self.revisions.entry(page_id).or_insert(0) += 1;
        }
        self.serialized_len = None;
    }
}

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

/// What a cancellable operation works on. A merge names no document until it
/// has built one, and the wizard is modal, so it is its own target.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum OperationTarget {
    Document(u64),
    Archive(u64),
    Merge,
    Search(u64),
    /// A compressed copy being estimated or written, whose page loop must
    /// stop when the reader walks away from the dialog.
    Compress(u64),
    /// The Word→PDF conversions behind a wizard inspection, which can outlast
    /// a reader's patience alone; a merge's stay under its own target.
    Convert,
}

struct RunningOperation {
    cancelled: Arc<AtomicBool>,
    target: OperationTarget,
}

/// Lists an operation while it runs, retiring it on every way out. The flag is
/// read between pages, which is what makes a long rebuild interruptible.
struct OperationGuard<'a> {
    cancelled: Arc<AtomicBool>,
    id: u64,
    operations: &'a Mutex<HashMap<u64, RunningOperation>>,
}

/// Poisoning must not be fatal here: the list is bookkeeping, and refusing it
/// would leave every later run uninterruptible.
fn lock_operations(
    operations: &Mutex<HashMap<u64, RunningOperation>>,
) -> MutexGuard<'_, HashMap<u64, RunningOperation>> {
    operations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl OperationGuard<'_> {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        lock_operations(self.operations).remove(&self.id);
    }
}

pub(super) struct PdfiumEngine {
    pdfium: &'static Pdfium,
    /// The open documents, and the lock serializing PDFium itself: it is not
    /// thread-safe, so hold this across *all* PDFium work, opening included.
    documents: Mutex<HashMap<u64, OpenDocument>>,
    next_document_id: AtomicU64,
    /// Every place the downloadable fallback face may be, in trial order —
    /// resolved at startup, the only point an `AppHandle` reaches this module.
    fallback_font_candidates: Vec<PathBuf>,
    /// The fallback face's static Regular instance, resolved on first use and
    /// kept — most sessions never fetch the ~17 MB source it is cut from.
    fallback_font: OnceLock<Vec<u8>>,
    /// The system's own sans pinned to Regular, or `None` where nothing on this
    /// machine can be embedded; resolved once, a scan of every installed face.
    system_face: OnceLock<Option<(Vec<u8>, usize)>>,
    page_number_font: OnceLock<Vec<u8>>,
    /// Paths something outside the WebView produced — a drop, a dialog pick. A
    /// path is a string any page code can make up, and opening one binds a save.
    approved_paths: Mutex<HashSet<PathBuf>>,
    /// The cancel flags of long operations now running, behind a lock of their
    /// own: the operation a cancel must reach holds `documents` for its whole run.
    operations: Mutex<HashMap<u64, RunningOperation>>,
    next_operation_id: AtomicU64,
    word: crate::convert::WordConverter,
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
            fallback_font_candidates: fallback_font_candidates(app),
            fallback_font: OnceLock::new(),
            system_face: OnceLock::new(),
            page_number_font: OnceLock::new(),
            approved_paths: Mutex::new(HashSet::new()),
            operations: Mutex::new(HashMap::new()),
            next_operation_id: AtomicU64::new(1),
            word: crate::convert::WordConverter::new(app),
        })))
    }

    pub fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        self.0.approve_paths(paths);
    }

    /// Closing takes the PDFium lock, so it must not block the window event loop.
    pub fn close_document_detached(&self, document_id: u64) {
        let engine = Arc::clone(&self.0);
        engine.cancel_document_work(document_id);

        tauri::async_runtime::spawn_blocking(move || {
            let _ = engine.close(document_id);
        });
    }
}

impl PdfiumEngine {
    pub(super) fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        if let Ok(mut approved) = self.approved_paths.lock() {
            approved.extend(paths.into_iter().cloned());
        }
    }

    /// Kept rather than consumed: the reader may cancel the unsaved guard and
    /// open the same file again; the e2e build waives the check at call sites.
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

    /// Lists a cancellable operation and hands back its guard. Called *before*
    /// the documents lock, so a cancel arriving while queued is still seen.
    fn begin_operation(&self, target: OperationTarget) -> OperationGuard<'_> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);

        lock_operations(&self.operations).insert(
            id,
            RunningOperation {
                cancelled: Arc::clone(&cancelled),
                target,
            },
        );

        OperationGuard {
            cancelled,
            id,
            operations: &self.operations,
        }
    }

    /// Flags every operation on `target` to stop, answering whether one
    /// listened. Takes no document lock — the operation it stops holds it.
    pub(super) fn cancel_operation(&self, target: OperationTarget) -> bool {
        let operations = lock_operations(&self.operations);
        let mut asked = false;

        for operation in operations.values() {
            if operation.target == target {
                operation.cancelled.store(true, Ordering::Relaxed);
                asked = true;
            }
        }

        asked
    }

    /// Cancel first so closing a document does not wait for its entire rebuild.
    pub(super) fn cancel_document_work(&self, document_id: u64) {
        self.cancel_operation(OperationTarget::Document(document_id));
        self.cancel_operation(OperationTarget::Search(document_id));
        self.cancel_operation(OperationTarget::Archive(document_id));
        self.cancel_operation(OperationTarget::Compress(document_id));
    }

    /// A new one-page A4 document, built in memory: no file of its own, so a
    /// save has nowhere to write until an export adopts a destination.
    pub(super) fn create_blank(&self) -> Result<PdfDocumentInfo, String> {
        let bytes = {
            // PDFium work like any other, so under the store's lock — given
            // back before `open_with_source` takes it again.
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

    pub(super) fn open_from_path(&self, path: PathBuf) -> Result<PdfDocumentInfo, String> {
        let bytes = read_pdf_bytes(&path)?;

        self.open_with_source(bytes, Some(path))
    }

    /// An image or a Word document opened as its converted PDF. Built in
    /// memory with no source binding, like `create_blank`: the file behind it
    /// is only ever read, so there is no destination for approval to guard.
    pub(super) fn open_converted(&self, path: PathBuf) -> Result<PdfDocumentInfo, String> {
        if is_merge_image(&path) {
            let bytes = {
                let _documents = self.lock_documents()?;
                let document = image_page_document(self.pdfium, &path)?;

                document
                    .save_to_bytes()
                    .map_err(|error| format!("PDFium could not build the image's PDF: {error}"))?
            };

            return self.open_with_source(bytes, None);
        }

        if crate::convert::is_word_document(&path) {
            // Stoppable like the wizard's inspection of the same file: an
            // office suite's startup is seconds the open flow must be able to
            // walk away from, and `cancel_word_conversion` aims at this target.
            let entry = {
                let operation = self.begin_operation(OperationTarget::Convert);
                let cancelled = || operation.is_cancelled();

                self.resolve_word_documents(
                    std::slice::from_ref(&path),
                    true,
                    &cancelled,
                    &mut || {},
                )
                .into_iter()
                .next()
            };

            return match entry {
                Some(crate::convert::Entry::Converted(pdf)) => {
                    self.open_with_source(read_pdf_bytes(&pdf)?, None)
                }
                Some(crate::convert::Entry::Failed(error)) => Err(format!(
                    "{} could not be converted: {error}",
                    path.display()
                )),
                _ => Err(format!("{} is not a convertible source", path.display())),
            };
        }

        Err(format!("{} is not a convertible source", path.display()))
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
        let DocumentLayout {
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
                document,
                marks: HashMap::new(),
                merged_page_ids: HashSet::new(),
                needs_compaction: false,
                next_mark_id: 1,
                next_page_id: num_pages as u64,
                owned_content: None,
                page_geometry: (0..num_pages as u64).zip(pages.iter().copied()).collect(),
                page_ids: (0..num_pages as u64).collect(),
                revisions: HashMap::new(),
                serialized_len: None,
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

    pub(super) fn search_text(
        &self,
        document_id: u64,
        query: &str,
    ) -> Result<PdfSearchOutcome, String> {
        // Rejected before normalization allocates a second string. The field has
        // a maxlength, but commands are callable directly and enforce their own.
        if query.chars().nth(MAX_SEARCH_CHARS).is_some() {
            return Err(format!(
                "a PDF search term may contain at most {MAX_SEARCH_CHARS} characters"
            ));
        }

        // Collapsed so a phrase pasted with a line break behaves like one typed
        // with a space; PDFium matches across its own line breaks the same way.
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");

        if query.is_empty() {
            return Err("a PDF search needs some text".into());
        }

        // Register before taking the one PDFium lock. A replacement search can
        // therefore stop this one even while it is queued behind another job.
        let operation = self.begin_operation(OperationTarget::Search(document_id));
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;
        let options = PdfSearchOptions::new();
        let mut matches = Vec::new();
        let mut rectangle_count = 0usize;

        for page_index in 0..entry.page_ids.len() {
            if operation.is_cancelled() {
                return Ok(PdfSearchOutcome {
                    cancelled: true,
                    limit_reached: false,
                    matches: Vec::new(),
                });
            }

            let page_number = page_index as i32 + 1;
            let page = entry
                .document
                .pages()
                .get(page_index as i32)
                .map_err(|error| {
                    format!("PDFium could not load page {page_number} for search: {error}")
                })?;
            let unrotated_height = unrotated_page_height(&page);
            let text = page.text().map_err(|error| {
                format!("PDFium could not read text on page {page_number}: {error}")
            })?;
            let search = text
                .search(&query, &options)
                .map_err(|error| format!("PDFium could not search page {page_number}: {error}"))?;

            for result in search.iter(PdfSearchDirection::SearchForward) {
                let rects = result
                    .iter()
                    .filter_map(|segment| {
                        let bounds = segment.bounds();
                        let left = bounds.left().value;
                        let top = bounds.top().value;
                        let width = bounds.right().value - left;
                        let height = top - bounds.bottom().value;

                        (width > 0.0 && height > 0.0).then_some(PagePointsRect {
                            left,
                            top: unrotated_height - top,
                            width,
                            height,
                        })
                    })
                    .collect::<Vec<_>>();

                if rects.is_empty() {
                    continue;
                }

                if matches.len() >= MAX_SEARCH_MATCHES
                    || rectangle_count.saturating_add(rects.len()) > MAX_SEARCH_RECTS
                {
                    return Ok(PdfSearchOutcome {
                        cancelled: false,
                        limit_reached: true,
                        matches,
                    });
                }

                rectangle_count += rects.len();
                matches.push(PdfSearchMatch { page_number, rects });
            }
        }

        Ok(PdfSearchOutcome {
            cancelled: false,
            limit_reached: false,
            matches,
        })
    }

    /// The page's text as PDFium reconstructs it, line breaks included — unlike
    /// the spans, positioned layout runs no reader would want on a clipboard.
    pub(super) fn extract_plain_text(
        &self,
        document_id: u64,
        page_number: i32,
    ) -> Result<String, String> {
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;

        entry.page_id(page_number)?;

        let page = entry
            .document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let text = page.text().map_err(|error| {
            format!("PDFium could not read text on page {page_number}: {error}")
        })?;

        Ok(text.all())
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

    fn system_face(&self) -> Option<&(Vec<u8>, usize)> {
        self.system_face
            .get_or_init(|| system_embedded_face(EMBEDDED_FACE_PROBE))
            .as_ref()
    }

    fn fallback_font_file(&self) -> Option<&Path> {
        self.fallback_font_candidates
            .iter()
            .find(|path| path.is_file())
            .map(PathBuf::as_path)
    }

    fn fallback_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.fallback_font.get() {
            return Ok(bytes);
        }

        // The one failure a reader can act on, so it travels as itself: the
        // frontend turns exactly this string into the offer to fetch the face.
        let path = self
            .fallback_font_file()
            .ok_or_else(|| FONT_MISSING_ERROR.to_string())?;
        let source = fs::read(path)
            .map_err(|error| format!("the fallback font could not be read: {error}"))?;
        let (bytes, _) = regular_face(&source, 0)?;

        // Two notes can resolve at once; whichever stores first wins, and both
        // then see the same Regular instance.
        let _ = self.fallback_font.set(bytes);

        self.fallback_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the fallback font could not be cached".to_string())
    }

    /// The system's sans first, then the downloaded fallback. Neither is held
    /// to covering `text`: a missing glyph draws boxes rather than refusing.
    fn embedded_face_subset(&self, text: &str) -> Result<Vec<u8>, String> {
        if let Some((bytes, index)) = self.system_face() {
            return subset_for(bytes, *index, text);
        }

        match self.fallback_font_bytes() {
            Ok(bytes) => subset_for(bytes, 0, text),
            // "Outside Latin-1" is not "Chinese": a sans drawing Cyrillic or
            // kana serves this run without fetching a 17 MB face; never cached.
            Err(missing) => {
                let (bytes, index) = system_embedded_face(text).ok_or(missing)?;

                subset_for(&bytes, index, text)
            }
        }
    }

    /// Resolved once and kept, already cut to the label's glyphs. The fallback
    /// for a refusing host keeps the chain's own error, not the fetch's.
    fn page_number_font_bytes(&self) -> Result<&[u8], String> {
        if let Some(bytes) = self.page_number_font.get() {
            return Ok(bytes);
        }

        let face = match page_number_face() {
            Ok(face) => face,
            Err(missing) => self
                .fallback_font_bytes()
                .and_then(|fallback| subset_for(fallback, 0, PAGE_NUMBER_GLYPHS))
                .map_err(|_| missing)?,
        };

        let _ = self.page_number_font.set(face);

        self.page_number_font
            .get()
            .map(Vec::as_slice)
            .ok_or_else(|| "the page-number font could not be cached".to_string())
    }

    pub(super) fn close(&self, document_id: u64) -> Result<(), String> {
        self.lock_documents()?.remove(&document_id);

        Ok(())
    }
}

/// Kept apart from `PdfStructureUpdate`, which carries the one fact a document
/// cannot know — whether a page came from another file.
struct DocumentLayout {
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
}

/// One page's geometry as the frontend receives it: the displayed size, the
/// page's own `/Rotate` already applied, and that rotation.
fn measure_page(page: &PdfPage<'_>) -> PdfPageInfo {
    PdfPageInfo {
        width: page.width().value,
        height: page.height().value,
        rotation: page_rotation_degrees(page),
    }
}

/// Measured out of PDFium page by page; what an open reports. Later structure
/// commands answer from `page_infos` instead, the same list off a memo.
fn document_layout(document: &PdfDocument<'static>) -> DocumentLayout {
    let pages = document.pages();

    DocumentLayout {
        num_pages: pages.len(),
        pages: pages.iter().map(|page| measure_page(&page)).collect(),
        outline: collect_bookmark_siblings(document.bookmarks().root()),
    }
}

/// What an unloadable page reports as: a gap would renumber every page after
/// it. Not memoised, so a page measurable later still will be.
const UNMEASURED_PAGE: PdfPageInfo = PdfPageInfo {
    width: 595.0,
    height: 842.0,
    rotation: 0.0,
};

/// Measures only pages not measured before, so a reorder or delete touches
/// PDFium not at all here. One entry per page, always, keeping the count stable.
fn page_infos(entry: &mut OpenDocument) -> Vec<PdfPageInfo> {
    let unmeasured = entry
        .page_ids
        .iter()
        .enumerate()
        .filter(|(_, page_id)| !entry.page_geometry.contains_key(page_id))
        .map(|(index, page_id)| (index as PdfPageIndex, *page_id))
        .collect::<Vec<_>>();
    let measured = {
        let pages = entry.document.pages();

        unmeasured
            .into_iter()
            .filter_map(|(index, page_id)| {
                let page = pages.get(index).ok()?;

                Some((page_id, measure_page(&page)))
            })
            .collect::<Vec<_>>()
    };

    entry.page_geometry.extend(measured);
    entry
        .page_ids
        .iter()
        .map(|page_id| {
            entry
                .page_geometry
                .get(page_id)
                .copied()
                .unwrap_or(UNMEASURED_PAGE)
        })
        .collect()
}

/// The layout a structure command reports, plus whether another file's pages
/// remain — read from the same set `save` refuses on, so the key cannot lie.
fn structure_update(entry: &mut OpenDocument) -> PdfStructureUpdate {
    let pages = page_infos(entry);

    PdfStructureUpdate {
        has_merged_pages: !entry.merged_page_ids.is_empty(),
        num_pages: pages.len() as i32,
        outline: collect_bookmark_siblings(entry.document.bookmarks().root()),
        pages,
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

mod archive_export;
mod compress;
mod inspection;
mod io;
mod marks;
mod owned_content;
mod page_ops;
mod raster_export;
pub(crate) use io::is_merge_image;
use io::{image_page_document, read_pdf_bytes};
use owned_content::OwnedContentState;
use page_ops::{page_index, PageStash};
use raster_export::{page_jpeg, RasterLevels, FLATTEN_LEVELS};

#[cfg(test)]
mod tests;
