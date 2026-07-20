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

/// The pull of a cubic Bézier's control points that turns four of them into a
/// near-perfect quarter circle — the standard constant for rounding a corner.
const CORNER_KAPPA: f32 = 0.552_284_75;

/// One step of a rectangle's outline after the opening `move_to`. Kept as data
/// rather than issued straight to PDFium so the corner geometry can be checked
/// without a rendering library.
#[derive(Debug, PartialEq)]
pub(super) enum RectPathSegment {
    LineTo {
        x: f32,
        y: f32,
    },
    BezierTo {
        x: f32,
        y: f32,
        c1x: f32,
        c1y: f32,
        c2x: f32,
        c2y: f32,
    },
}

/// A rectangle's outline as a start point and the segments that follow it,
/// closed by the caller. `close_path` draws the final edge back to `start`.
pub(super) struct RectPath {
    pub(super) start: (f32, f32),
    pub(super) segments: Vec<RectPathSegment>,
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
pub(super) const MIN_RECT_STROKE_WIDTH: f32 = 1.0;
pub(super) const MAX_RECT_STROKE_WIDTH: f32 = 12.0;
pub(super) const MAX_RECT_CORNER_RADIUS: f32 = 40.0;
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

/// Holds `radius` to what a rectangle this size can take: past half the shorter
/// side the corner arcs would meet and cross, folding the outline in on itself.
pub(super) fn clamp_corner_radius(width: f32, height: f32, radius: f32) -> f32 {
    radius.max(0.0).min(width.min(height) / 2.0)
}

/// The outline of `rect` with corners of `radius`, in PDFium's bottom-left
/// space. A radius at or below zero is four straight edges; above it, each
/// corner is a quarter-circle Bézier so the shape stays vector — a rounded box
/// is common enough that rasterising it would be a visible loss on zoom.
pub(super) fn rect_path(rect: &PdfRect, radius: f32) -> RectPath {
    let (l, r) = (rect.left().value, rect.right().value);
    let (b, t) = (rect.bottom().value, rect.top().value);

    if radius <= 0.0 {
        return RectPath {
            start: (l, b),
            segments: vec![
                RectPathSegment::LineTo { x: r, y: b },
                RectPathSegment::LineTo { x: r, y: t },
                RectPathSegment::LineTo { x: l, y: t },
            ],
        };
    }

    let c = radius * CORNER_KAPPA;

    RectPath {
        start: (l + radius, b),
        segments: vec![
            RectPathSegment::LineTo {
                x: r - radius,
                y: b,
            },
            RectPathSegment::BezierTo {
                x: r,
                y: b + radius,
                c1x: r - radius + c,
                c1y: b,
                c2x: r,
                c2y: b + radius - c,
            },
            RectPathSegment::LineTo {
                x: r,
                y: t - radius,
            },
            RectPathSegment::BezierTo {
                x: r - radius,
                y: t,
                c1x: r,
                c1y: t - radius + c,
                c2x: r - radius + c,
                c2y: t,
            },
            RectPathSegment::LineTo {
                x: l + radius,
                y: t,
            },
            RectPathSegment::BezierTo {
                x: l,
                y: t - radius,
                c1x: l + radius - c,
                c1y: t,
                c2x: l,
                c2y: t - radius + c,
            },
            RectPathSegment::LineTo {
                x: l,
                y: b + radius,
            },
            RectPathSegment::BezierTo {
                x: l + radius,
                y: b,
                c1x: l,
                c1y: b + radius - c,
                c2x: l + radius - c,
                c2y: b,
            },
        ],
    }
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
    fn clamps_a_corner_radius_to_half_the_shorter_side() {
        assert_eq!(clamp_corner_radius(100.0, 60.0, 40.0), 30.0);
        assert_eq!(clamp_corner_radius(100.0, 60.0, 10.0), 10.0);
        assert_eq!(clamp_corner_radius(100.0, 60.0, -5.0), 0.0);
        // A non-finite radius resolves to a real number, never carried into the path.
        assert_eq!(clamp_corner_radius(100.0, 60.0, f32::NAN), 0.0);
        assert_eq!(clamp_corner_radius(100.0, 60.0, f32::INFINITY), 30.0);
    }

    #[test]
    fn traces_a_right_angle_when_the_radius_is_zero() {
        let path = rect_path(&PdfRect::new_from_values(0.0, 0.0, 100.0, 80.0), 0.0);

        assert_eq!(path.start, (0.0, 0.0));
        assert_eq!(
            path.segments,
            vec![
                RectPathSegment::LineTo { x: 80.0, y: 0.0 },
                RectPathSegment::LineTo { x: 80.0, y: 100.0 },
                RectPathSegment::LineTo { x: 0.0, y: 100.0 },
            ]
        );
    }

    #[test]
    fn rounds_each_corner_with_a_bezier() {
        let path = rect_path(&PdfRect::new_from_values(0.0, 0.0, 100.0, 100.0), 20.0);

        // One straight edge and one curved corner, four times over: the outline
        // starts a radius in from a corner rather than on it.
        assert_eq!(path.start, (20.0, 0.0));
        assert_eq!(path.segments.len(), 8);

        let corners: Vec<_> = path
            .segments
            .iter()
            .filter_map(|segment| match segment {
                RectPathSegment::BezierTo { x, y, .. } => Some((*x, *y)),
                RectPathSegment::LineTo { .. } => None,
            })
            .collect();
        // Each arc ends a radius along the next edge, walking anticlockwise.
        assert_eq!(
            corners,
            vec![(100.0, 20.0), (80.0, 100.0), (0.0, 80.0), (20.0, 0.0)]
        );

        // The first corner's control points pull towards the corner it rounds.
        let control = match path.segments[1] {
            RectPathSegment::BezierTo {
                c1x, c1y, c2x, c2y, ..
            } => (c1x, c1y, c2x, c2y),
            _ => panic!("the first corner should be a bezier"),
        };
        let c = 20.0 * CORNER_KAPPA;
        assert!((control.0 - (80.0 + c)).abs() < 1e-3);
        assert_eq!(control.1, 0.0);
        assert_eq!(control.2, 100.0);
        assert!((control.3 - (20.0 - c)).abs() < 1e-3);
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
