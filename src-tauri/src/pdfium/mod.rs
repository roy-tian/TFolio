mod commands;
mod engine;
mod font;
mod geometry;
mod library;
mod page_numbers;
mod watermark;

use serde::{Deserialize, Serialize};

pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, close_pdf,
    create_pdf, delete_last_pdf_annotation, delete_pdf_pages, export_pdf, extract_pdf_page_text,
    insert_pdf_blank_page, merge_pdf_from_path, open_pdf, open_pdf_from_path, pick_pdf_path,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    reorder_pdf_pages, restore_pdf_pages, save_pdf,
};
pub use engine::PdfiumState;
pub use page_numbers::PageNumbersConfig;
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

#[derive(Serialize)]
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
}

/// What a merge appended: where the source's first page landed, how many pages
/// it brought, and the fresh document metadata. The frontend derives the merged
/// file's page range from `page_count` — the one thing it cannot know until the
/// backend has read the file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    inserted_at: i32,
    page_count: i32,
    update: PdfStructureUpdate,
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

#[derive(Debug, Serialize)]
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

/// How a text note is drawn. `font_family` picks one of the standard 14 and is
/// ignored for text that needs the bundled CJK font, which is the only face
/// available once a note leaves Latin-1 — the frontend disables the control to
/// match rather than letting a reader pick a face they will not get.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextNoteStyle {
    /// `"sans"`, `"serif"` or `"mono"`.
    font_family: String,
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
