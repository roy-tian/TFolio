mod commands;
mod engine;
mod font;
mod geometry;
mod library;
mod outline;
mod page_numbers;
mod watermark;

use serde::{Deserialize, Serialize};

pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_merge,
    cancel_pdf_operation, cancel_pdf_search, close_pdf, create_pdf, delete_pdf_annotations,
    delete_pdf_pages, download_pdf_note_font, duplicate_pdf_pages, export_pdf,
    extract_pdf_page_plain_text, extract_pdf_page_text, insert_pdf_blank_page,
    insert_pdf_from_path, insert_pdf_pages_from_document, inspect_pdf_files, merge_pdf_files,
    open_pdf, open_pdf_from_path, pdf_annotation_at_point, pick_pdf_path, pick_pdf_paths,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    reorder_pdf_pages, restore_pdf_pages, save_pdf, search_pdf_text,
};
pub use engine::PdfiumState;
pub use page_numbers::{PageNumbersConfig, PageNumbersPreferences};
pub use watermark::WatermarkConfig;

const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;

/// The one wording for the size refusal, from all three checks: the frontend
/// tells "too large" apart from every other open failure by the "MiB limit"
/// substring (see `loadPdfFromPath` in `App.tsx`), so the message must never
/// vary by call site.
fn size_limit_error() -> String {
    format!(
        "PDF file exceeds the {} MiB limit",
        MAX_PDF_BYTES / 1024 / 1024
    )
}

/// A bounded operation's completed work, streamed to the WebView over a Tauri
/// channel. Both values count work units rather than bytes: pages for owned
/// content, and source/finishing stages for a merge.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfProgress {
    completed: usize,
    total: usize,
}

impl PdfProgress {
    fn new(completed: usize, total: usize) -> Self {
        Self { completed, total }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocumentInfo {
    id: u64,
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
    /// The file this document was opened from. `None` — opened from bytes —
    /// disables saving; only exporting can give it a file.
    path: Option<String>,
}

/// Fresh metadata after a page-structure change. The frontend holds no mirror
/// of the page list to patch, so it replaces its copy wholesale.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfStructureUpdate {
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
    /// Whether any page another file brought in is still in the document —
    /// which, like a watermark, leaves it export-only. The frontend's save key
    /// reads this instead of replaying its own history, so it asks exactly the
    /// question `save` refuses on.
    has_merged_pages: bool,
}

/// What an insert brought in: how many pages the source held, and the fresh
/// document metadata. The frontend chose the position, but `page_count` is the
/// one thing it cannot know until the backend has read the file — and what its
/// undo needs to know which pages to take back out.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertOutcome {
    page_count: i32,
    update: PdfStructureUpdate,
}

/// How a guided merge turns its sources' bookmarks into the merged document's
/// outline. Every mode but `None` needs an outline written, which PDFium cannot
/// do — see `outline.rs`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeBookmarks {
    /// No outline at all — the shape a merge already produces, since imported
    /// pages leave their source's bookmarks behind.
    None,
    /// One top-level bookmark per file, on the file's first page.
    PerFile,
    /// Each file's own bookmarks, remapped onto their merged positions and laid
    /// out one file after another at the top level.
    KeepExisting,
    /// One bookmark per file, with that file's own bookmarks beneath it.
    PerFileWithExisting,
}

/// What one candidate file of a guided merge holds, read before anything is
/// merged so the wizard can show page counts and total up the result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFileSummary {
    path: String,
    /// `None` when the file could not be read as a PDF, so the row shows as
    /// unusable rather than silently going missing from the list.
    page_count: Option<i32>,
    /// Whether the file brings bookmarks of its own — what makes the
    /// bookmark-keeping modes worth offering.
    has_outline: bool,
}

/// What an export wrote and where it stands relative to the document's source.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    path: String,
    /// Whether the write landed on the document's own source path — true for a
    /// byte-opened document's first export too, which adopts its destination as
    /// the source. This, not the operation's name, is what decides whether the
    /// history counts as saved.
    saved_to_source: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
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
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePointsRect {
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

/// One occurrence of a search term on a page. A wrapped occurrence has one
/// rectangle per line; keeping those rectangles together is what makes the
/// result counter advance by occurrences rather than by the lines they cross.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchMatch {
    page_number: i32,
    rects: Vec<PagePointsRect>,
}

/// A document search can be stopped when its term changes. Partial matches are
/// never returned as a result for the new term; `cancelled` lets the frontend
/// quietly discard the interrupted run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchOutcome {
    cancelled: bool,
    /// True when the bounded IPC result has more occurrences than it can safely
    /// retain. The returned prefix remains navigable and is labelled as such.
    limit_reached: bool,
    matches: Vec<PdfSearchMatch>,
}

/// How a rectangle annotation is drawn: a block of `color` with `opacity` on
/// its alpha. There is no border and no corner radius — a rectangle covers what
/// is under it, and the reader picks how much of it still shows through.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectStyle {
    color: String,
    opacity: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectEffect {
    kind: RectEffectKind,
    /// Mosaic block size or blur sigma, in page points.
    strength: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum RectEffectKind {
    Mosaic,
    Blur,
}

/// A point in the same space `PagePointsRect` uses: *unrotated* page points with
/// a top-left origin. A note is placed by its top-left corner, where the reader
/// clicked, rather than by the text baseline PDFium draws from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePoint {
    left: f32,
    top: f32,
}

/// How a text note is drawn. There is no family to pick: Latin text is drawn in
/// Helvetica, and anything else in whichever face the machine can actually
/// embed, so a control here would have offered a choice a note might not get.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextNoteStyle {
    /// Point size, as a PDF measures type.
    font_size: f32,
    color: String,
    opacity: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfOutlineItem {
    title: String,
    page_number: Option<i32>,
    items: Vec<PdfOutlineItem>,
}
