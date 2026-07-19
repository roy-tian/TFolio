mod commands;
mod engine;
mod font;
mod geometry;
mod library;

use serde::{Deserialize, Serialize};

pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, close_pdf, delete_last_pdf_annotation, export_pdf,
    extract_pdf_page_text, open_pdf, open_pdf_from_path, pick_pdf_path, render_pdf_page,
    render_pdf_page_thumbnail, save_pdf,
};
pub use engine::PdfiumState;

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

/// What an export wrote and where it stands relative to the document's source.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    path: String,
    /// Whether the write landed on the document's own source path — true for a
    /// byte-opened document's first export too, which adopts its destination as
    /// the source. This, not the operation's name, is what decides whether the
    /// history counts as saved.
    saved_to_source: bool,
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

/// How a rectangle annotation is drawn. A colour left `None` means that part is
/// absent — no border, or no fill — so a rectangle can be a hollow outline, a
/// solid block, or both. `opacity` rides the alpha of whichever are present.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectStyle {
    stroke_color: Option<String>,
    fill_color: Option<String>,
    opacity: f32,
    /// Corner radius in page points; 0 is a right angle. Clamped to half the
    /// shorter side so the corners cannot cross and turn the path inside out.
    corner_radius: f32,
    stroke_width: f32,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfOutlineItem {
    title: String,
    page_number: Option<i32>,
    items: Vec<PdfOutlineItem>,
}
