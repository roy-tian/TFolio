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

/// A4 at 72 points to the inch: 210 x 297 mm, the sheet a normalized merge
/// fits every page onto. Held here rather than taken from
/// `PdfPagePaperSize::a4()` because the placement arithmetic below is pure and
/// must be testable without PDFium loaded.
pub(super) const A4_SHORT_POINTS: f32 = 595.276;
pub(super) const A4_LONG_POINTS: f32 = 841.89;

/// Where one page lands once it is fitted to an A4 sheet: the sheet's own size,
/// the factor the page is drawn at, and the offset that centres it there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct A4Placement {
    pub(super) sheet_width: f32,
    pub(super) sheet_height: f32,
    pub(super) scale: f32,
    pub(super) left: f32,
    pub(super) bottom: f32,
}

/// Fits a page of `width` x `height` *displayed* points onto an A4 sheet.
///
/// A page that already fits is never enlarged — it keeps its own size in the
/// middle of the sheet — and one that does not is shrunk on both axes by the
/// same factor. The sheet turns landscape only where that is the orientation
/// the page fits better in, so portrait wins every tie: a small page fits both
/// ways at full size, and portrait is the one a reader expects.
///
/// Sizes that are not finite and positive cannot be fitted to anything; they
/// come back as an unscaled portrait sheet, which leaves the page where PDFium
/// put it rather than moving it by a nonsense offset.
pub(super) fn a4_placement(width: f32, height: f32) -> A4Placement {
    let portrait = |scale: f32| A4Placement {
        sheet_width: A4_SHORT_POINTS,
        sheet_height: A4_LONG_POINTS,
        scale,
        left: (A4_SHORT_POINTS - width * scale) / 2.0,
        bottom: (A4_LONG_POINTS - height * scale) / 2.0,
    };

    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return A4Placement {
            left: 0.0,
            bottom: 0.0,
            ..portrait(1.0)
        };
    }

    let fit = |sheet_width: f32, sheet_height: f32| {
        (sheet_width / width).min(sheet_height / height).min(1.0)
    };
    let upright = fit(A4_SHORT_POINTS, A4_LONG_POINTS);
    let sideways = fit(A4_LONG_POINTS, A4_SHORT_POINTS);

    if sideways > upright {
        A4Placement {
            sheet_width: A4_LONG_POINTS,
            sheet_height: A4_SHORT_POINTS,
            scale: sideways,
            left: (A4_LONG_POINTS - width * sideways) / 2.0,
            bottom: (A4_SHORT_POINTS - height * sideways) / 2.0,
        }
    } else {
        portrait(upright)
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

/// Whether `(x, y)` — in PDFium's own bottom-left page space — lands on what
/// this annotation draws.
///
/// A text markup annotation's `/Rect` encloses every run it covers, so a
/// highlight wrapped across three lines would answer for the whole block down
/// to its ragged right edge. Its quad points are what it actually paints, so
/// they are what a point is tested against wherever it has them.
pub(super) fn annotation_covers(annotation: &PdfPageAnnotation<'_>, x: f32, y: f32) -> bool {
    let points = annotation.attachment_points();

    if !points.is_empty() {
        return points.iter().any(|quad| rect_covers(&quad.to_rect(), x, y));
    }

    annotation
        .bounds()
        .is_ok_and(|bounds| rect_covers(&bounds, x, y))
}

fn rect_covers(rect: &PdfRect, x: f32, y: f32) -> bool {
    x >= rect.left().value
        && x <= rect.right().value
        && y >= rect.bottom().value
        && y <= rect.top().value
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
    fn leaves_a_page_that_already_fits_a4_at_its_own_size() {
        let placement = a4_placement(200.0, 300.0);

        assert_eq!(placement.scale, 1.0);
        assert_eq!(placement.sheet_width, A4_SHORT_POINTS);
        assert_eq!(placement.sheet_height, A4_LONG_POINTS);
        assert!((placement.left - (A4_SHORT_POINTS - 200.0) / 2.0).abs() < 0.001);
        assert!((placement.bottom - (A4_LONG_POINTS - 300.0) / 2.0).abs() < 0.001);
    }

    #[test]
    fn turns_the_sheet_sideways_only_where_upright_would_not_hold_the_page() {
        // 700pt across is wider than A4 upright but fits it lying down, so the
        // page keeps its own size on a landscape sheet.
        let wide = a4_placement(700.0, 500.0);

        assert_eq!(wide.scale, 1.0);
        assert_eq!(wide.sheet_width, A4_LONG_POINTS);
        assert_eq!(wide.sheet_height, A4_SHORT_POINTS);

        // A square fits both ways at full size; portrait is the tie's answer.
        assert_eq!(a4_placement(400.0, 400.0).sheet_width, A4_SHORT_POINTS);
    }

    #[test]
    fn shrinks_an_oversized_page_onto_the_orientation_that_holds_more_of_it() {
        let tall = a4_placement(900.0, 1000.0);

        assert_eq!(tall.sheet_width, A4_SHORT_POINTS);
        assert!((tall.scale - A4_SHORT_POINTS / 900.0).abs() < 0.001);
        // Shrunk on both axes by the one factor, and centred on what is left.
        assert!(tall.left.abs() < 0.001);
        assert!((tall.bottom - (A4_LONG_POINTS - 1000.0 * tall.scale) / 2.0).abs() < 0.001);

        let broad = a4_placement(2000.0, 1000.0);

        assert_eq!(broad.sheet_width, A4_LONG_POINTS);
        assert!((broad.scale - A4_LONG_POINTS / 2000.0).abs() < 0.001);
    }

    #[test]
    fn refuses_to_place_a_page_of_no_usable_size() {
        for placement in [
            a4_placement(0.0, 300.0),
            a4_placement(f32::NAN, 300.0),
            a4_placement(200.0, f32::INFINITY),
            a4_placement(-10.0, 300.0),
        ] {
            assert_eq!(placement.scale, 1.0);
            assert_eq!(placement.left, 0.0);
            assert_eq!(placement.bottom, 0.0);
        }
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
