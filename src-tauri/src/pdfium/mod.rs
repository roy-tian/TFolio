mod archive;
mod archive_links;
mod commands;
mod compress;
mod engine;
mod font;
mod geometry;
mod library;
mod outline;
mod page_numbers;
mod watermark;

use serde::{Deserialize, Serialize};

pub use archive::{cancel_pdf_archive, export_pdf_archive};
#[cfg(feature = "e2e")]
pub use commands::export_pdf_to;
pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_merge,
    cancel_pdf_operation, cancel_pdf_search, cancel_word_conversion, close_pdf, create_pdf,
    delete_pdf_annotations, delete_pdf_pages, download_pdf_note_font, duplicate_pdf_pages,
    export_pdf, extract_pdf_page_plain_text, extract_pdf_page_text, insert_pdf_blank_page,
    insert_pdf_from_path, insert_pdf_pages_from_document, inspect_pdf_files, merge_pdf_files,
    open_converted_from_path, open_pdf, open_pdf_from_path, pdf_annotation_at_point, pick_pdf_path,
    pick_pdf_paths, remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page,
    render_pdf_page_thumbnail, reorder_pdf_pages, restore_pdf_pages, rotate_pdf_pages, save_pdf,
    search_pdf_text,
};
pub use compress::{
    cancel_pdf_compression, estimate_pdf_compression, export_compressed_pdf,
    release_pdf_compression,
};
pub use engine::PdfiumState;
// `launch.rs` reads the image kinds for its own launch test.
pub(crate) use engine::is_merge_image;
pub use page_numbers::{PageNumbersConfig, PageNumbersPreferences};
pub use watermark::WatermarkConfig;

// The one ceiling every PDF this app reads is held to, wherever it came from
// — also the ceiling a conversion's output must meet before it is one.
pub(crate) const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;

/// The frontend matches this refusal by its "MiB limit" substring
/// (`loadPdfFromPath` in `App.tsx`), so every call site shares one wording.
fn size_limit_error() -> String {
    format!(
        "PDF file exceeds the {} MiB limit",
        MAX_PDF_BYTES / 1024 / 1024
    )
}

/// Counts work units rather than bytes: pages for owned content, and
/// source/finishing stages for a merge.
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

/// The frontend holds no mirror of the page list to patch, so it replaces its
/// copy wholesale after every structure change.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfStructureUpdate {
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
    /// Like a watermark, any page another file brought in leaves the document
    /// export-only; the frontend's save key reads this, not its own history.
    has_merged_pages: bool,
}

/// `page_count` is the one thing the frontend cannot know until the file is
/// read — and what its undo needs to know which pages to take back out.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertOutcome {
    page_count: i32,
    update: PdfStructureUpdate,
}

/// How a merge turns its sources' bookmarks into the merged outline. Every
/// mode but `None` needs an outline written, which PDFium cannot do.
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    paths: Vec<String>,
    /// A blank before any file that would otherwise open on an even page.
    smart_padding: bool,
    /// Every page laid on an A4 sheet of its own instead of keeping the size its
    /// source gave it.
    normalize_a4: bool,
    bookmarks: MergeBookmarks,
}

/// An image is laid on a sheet of its own; a Word document arrives as the PDF
/// this machine's office suite made of it — the only renderer it can be trusted to.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeSourceKind {
    Pdf,
    Image,
    Word,
}

/// Why a Word document could not become a PDF. The wizard words these itself;
/// the detail an engine reported stays in the error it came with.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeSourceError {
    ConverterMissing,
    ConversionFailed,
}

/// Read before anything is merged, so the wizard can show page counts and
/// total up the result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFileSummary {
    path: String,
    kind: MergeSourceKind,
    /// `None` when the file could not be read, so the row shows as
    /// unusable rather than silently going missing from the list.
    page_count: Option<i32>,
    all_pages_a4: Option<bool>,
    /// Whether the file brings bookmarks of its own — what makes the
    /// bookmark-keeping modes worth offering.
    has_outline: bool,
    /// Set only where "unreadable" would understate the row: a Word document
    /// that no installed application could convert, or none could be found.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<MergeSourceError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    path: String,
    /// Whether the document is now bound to `path` — false only for a copy-only
    /// document's copy. This, not the operation's name, marks the history saved.
    saved_to_source: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct PdfPageInfo {
    // `width`/`height` are displayed dimensions (`/Rotate` already applied),
    // matching the rendered bitmap; `rotation` orients the frontend text layer.
    width: f32,
    height: f32,
    rotation: f32,
}

/// A text run's bounding box in *unrotated* page points, top-left origin: the
/// frontend rotates the whole text layer by the page's rotation.
#[derive(Serialize)]
pub struct PdfTextSpan {
    text: String,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

/// *Unrotated* page points with a top-left origin, so callers never have to
/// know which way PDFium counts its own axes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePointsRect {
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

/// One occurrence; a wrapped one has a rectangle per line, kept together so
/// the result counter advances by occurrences rather than lines.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchMatch {
    page_number: i32,
    rects: Vec<PagePointsRect>,
}

/// A search can be stopped when its term changes; `cancelled` lets the
/// frontend discard the interrupted run's partial matches.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchOutcome {
    cancelled: bool,
    /// True when the bounded IPC result has more occurrences than it can safely
    /// retain. The returned prefix remains navigable and is labelled as such.
    limit_reached: bool,
    matches: Vec<PdfSearchMatch>,
}

/// A block of `color` with `opacity` on its alpha — no border or radius: the
/// reader picks how much of what is under it still shows through.
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

/// The same space `PagePointsRect` uses. A note is placed by its top-left
/// corner — where the reader clicked — not the baseline PDFium draws from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePoint {
    left: f32,
    top: f32,
}

/// No family to pick: Latin text draws in Helvetica, anything else in a face
/// the machine can embed — a control would offer a choice a note might not get.
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
