mod archive;
mod archive_links;
mod compress;
mod engine;
mod font;
mod geometry;
mod library;
mod outline;
mod page_numbers;
mod watermark;

use serde::{Deserialize, Serialize};

pub use archive::{ArchiveOptions, ImageFormat};
pub use compress::{CompressionEstimate, CompressionOptions};
pub use engine::{
    is_merge_image, AssembleOutlineItem, AssemblePlan, AssembleSlot, EnginePaths, OperationTarget,
    OrganizeSourceInfo, PdfiumEngine, MERGE_IMAGE_EXTENSIONS, ORGANIZE_SOURCE_CHANGED,
};
pub use font::{download_fallback_font, CJK_FONT_NAME};
pub use library::PDFIUM_LIBRARY_NAME;
pub use page_numbers::{PageNumbersConfig, PageNumbersPreferences};
pub use watermark::WatermarkConfig;

// The one ceiling every PDF this app reads is held to, wherever it came from
// — also the ceiling a conversion's output must meet before it is one.
pub const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;

/// The frontend matches this refusal by its "MiB limit" substring
/// (`loadPdfFromPath` in `App.tsx`), so every call site shares one wording.
pub fn size_limit_error() -> String {
    format!(
        "PDF file exceeds the {} MiB limit",
        MAX_PDF_BYTES / 1024 / 1024
    )
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

impl PdfDocumentInfo {
    pub fn id(&self) -> u64 {
        self.id
    }
}

/// The frontend holds no mirror of the page list to patch, so it replaces its
/// copy wholesale after every structure change.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfStructureUpdate {
    num_pages: i32,
    pages: Vec<PdfPageInfo>,
    outline: Vec<PdfOutlineItem>,
    /// Like a watermark, a copy of a page carrying one or page numbers leaves the
    /// document export-only; the frontend's save key reads this, not its history.
    has_merged_pages: bool,
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

/// Why a Word document could not become a PDF. The workspace words these itself;
/// the detail an engine reported stays in the error it came with.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeSourceError {
    ConverterMissing,
    ConversionFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    path: String,
    /// Whether the document is now bound to `path` — false only for a copy-only
    /// document's copy. This, not the operation's name, marks the history saved.
    saved_to_source: bool,
}

impl ExportOutcome {
    pub fn saved_to_source(&self) -> bool {
        self.saved_to_source
    }
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
