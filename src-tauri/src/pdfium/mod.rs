mod commands;
mod engine;
mod geometry;
mod library;

use serde::{Deserialize, Serialize};

pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, close_pdf, delete_last_pdf_annotation,
    export_pdf, extract_pdf_page_text, open_pdf, render_pdf_page, render_pdf_page_thumbnail,
};
pub use engine::PdfiumState;

const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfOutlineItem {
    title: String,
    page_number: Option<i32>,
    items: Vec<PdfOutlineItem>,
}
