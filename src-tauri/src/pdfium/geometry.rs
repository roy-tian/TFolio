use pdfium_render::prelude::*;

use super::PagePointsRect;

/// The page's intrinsic clockwise `/Rotate` in degrees (0/90/180/270), or 0 if
/// PDFium cannot report it.
pub(super) fn page_rotation_degrees(page: &PdfPage<'_>) -> f32 {
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
pub(super) fn unrotated_page_height(page: &PdfPage<'_>) -> f32 {
    unrotated_page_size(page).1
}

/// A page's width and height before its intrinsic `/Rotate` is applied.
pub(super) fn unrotated_page_size(page: &PdfPage<'_>) -> (f32, f32) {
    let rotation = page_rotation_degrees(page);

    if rotation == 90.0 || rotation == 270.0 {
        (page.height().value, page.width().value)
    } else {
        (page.width().value, page.height().value)
    }
}

/// The exact inverse of the flip `extract_text` applies on the way out.
pub(super) fn page_rect_to_pdfium(rect: &PagePointsRect, unrotated_height: f32) -> PdfRect {
    PdfRect::new_from_values(
        unrotated_height - (rect.top + rect.height),
        rect.left,
        unrotated_height - rect.top,
        rect.left + rect.width,
    )
}

/// Opacity rides the alpha channel, which is where PDFium reads an annotation's
/// transparency from.
pub(super) fn annotation_color(hex: &str, opacity: f32) -> Result<PdfColor, String> {
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
pub(super) fn quad_points_from_rect(rect: &PdfRect) -> PdfQuadPoints {
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

/// The ceiling on a coordinate a rectangle carries, in page points. The PDF spec
/// caps a page's MediaBox at 14400pt; this leaves generous room past that, so a
/// real annotation always fits while an absurd value from the WebView falls
/// outside and is refused.
const MAX_PAGE_POINTS: f32 = 100_000.0;

/// The ranges a rectangle's style values may use. These mirror the sliders in
/// `src/lib/annotationStyles.ts` — together they are the app's one contract for
/// a rectangle style — so keep the two in step if a slider's range changes.
pub(super) const MIN_RECT_OPACITY: f32 = 0.1;
pub(super) const MIN_RECT_EFFECT_STRENGTH: f32 = 2.0;
pub(super) const MAX_RECT_EFFECT_STRENGTH: f32 = 24.0;

/// The ranges a text note's style values may use, held to the same contract with
/// `src/lib/annotationStyles.ts` as the rectangle constants above.
pub(super) const MIN_TEXT_NOTE_OPACITY: f32 = 0.1;
pub(super) const MIN_TEXT_NOTE_FONT_SIZE: f32 = 6.0;
pub(super) const MAX_TEXT_NOTE_FONT_SIZE: f32 = 72.0;

/// A ceiling on a note's length. Every character is a glyph in the subset this
/// note embeds and every line is a PDFium call made under the lock renders wait
/// on, so a pasted novel is refused rather than left to stall the app.
pub(super) const MAX_TEXT_NOTE_CHARS: usize = 4096;
pub(super) const MAX_TEXT_NOTE_LINES: usize = 256;

/// The baseline-to-baseline step between a note's lines, as a multiple of its
/// font size — normal prose leading, since a note is prose.
pub(super) const TEXT_NOTE_LINE_HEIGHT: f32 = 1.2;

/// How far a note's bounds sit outside its ink, in page points.
pub(super) const TEXT_NOTE_BOUNDS_MARGIN: f32 = 1.0;

/// Whether `value` is a coordinate a rectangle could really carry.
pub(super) fn within_page_range(value: f32) -> bool {
    value.is_finite() && value.abs() <= MAX_PAGE_POINTS
}

/// The smallest rectangle covering every one of `rects`, or `None` if empty.
pub(super) fn union_rect(rects: &[PdfRect]) -> Option<PdfRect> {
    rects.iter().copied().reduce(|union, rect| {
        PdfRect::new(
            union.bottom().min(rect.bottom()),
            union.left().min(rect.left()),
            union.top().max(rect.top()),
            union.right().max(rect.right()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_page_values_to_a_usable_range() {
        // A real page and annotation sit well inside the range.
        assert!(within_page_range(0.0));
        assert!(within_page_range(-14400.0));
        assert!(within_page_range(14400.0));
        // Non-finite or absurd is outside it, whichever sign.
        assert!(!within_page_range(f32::NAN));
        assert!(!within_page_range(f32::INFINITY));
        assert!(!within_page_range(f32::MAX));
        assert!(!within_page_range(1.0e30));
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
        let rect = page_rect_to_pdfium(
            &PagePointsRect {
                height: 12.0,
                left: 10.0,
                top: 20.0,
                width: 80.0,
            },
            300.0,
        );

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

        // Full opacity is a full byte; the range itself is enforced by the callers.
        assert_eq!(
            annotation_color("#ffd54a", 1.0)
                .expect("a hex colour is usable")
                .alpha(),
            255
        );
        assert!(annotation_color("nope", 0.4).is_err());
    }
}
