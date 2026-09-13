use serde::{Deserialize, Serialize};

pub(super) const MAX_WATERMARK_CHARS: usize = 256;
pub(super) const MAX_WATERMARK_DOCUMENT_OBJECTS: usize = 20_000;
pub(super) const MAX_WATERMARK_OBJECTS_PER_PAGE: usize = 512;
pub(super) const MIN_WATERMARK_WIDTH_RATIO: f32 = 0.1;
pub(super) const MAX_WATERMARK_WIDTH_RATIO: f32 = 1.0;

/// Mirrored by `src/lib/watermark.ts`, so the dialog's preview shows this ink.
pub(super) const WATERMARK_COLOR: &str = "#64748b";
pub(super) const WATERMARK_OPACITY: f32 = 0.25;
/// The zebra gap as a share of the font size, so one density holds at any size.
pub(super) const WATERMARK_ZEBRA_GAP_RATIO: f32 = 1.5;

/// Any reference size would do; a large one keeps the ratio clear of the
/// rounding a 1pt box would carry into it.
pub(super) const WATERMARK_REFERENCE_FONT_SIZE: f32 = 100.0;
/// Bounds on the *derived* size — a guard against a degenerate measurement or a
/// hostile page box, not a choice offered to the reader.
pub(super) const MIN_WATERMARK_FONT_SIZE: f32 = 1.0;
pub(super) const MAX_WATERMARK_FONT_SIZE: f32 = 1_000.0;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkConfig {
    #[serde(default)]
    pub(super) rasterize: bool,
    pub(super) text: String,
    pub(super) width_ratio: f32,
    pub(super) direction: WatermarkDirection,
    pub(super) layout: WatermarkLayout,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WatermarkDirection {
    Ascending,
    Descending,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WatermarkLayout {
    Single,
    Zebra,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct WatermarkPlacement {
    pub(super) center_x: f32,
    pub(super) center_y: f32,
}

impl WatermarkConfig {
    pub(super) fn validated(mut self) -> Result<Self, String> {
        self.text = self.text.trim().to_owned();
        if self.text.is_empty() {
            return Err("a watermark needs some text".into());
        }
        if self.text.contains(['\n', '\r']) {
            return Err("a watermark must fit on one line".into());
        }
        if self.text.chars().count() > MAX_WATERMARK_CHARS {
            return Err(format!(
                "a watermark may contain at most {MAX_WATERMARK_CHARS} characters"
            ));
        }
        if !in_range(
            self.width_ratio,
            MIN_WATERMARK_WIDTH_RATIO,
            MAX_WATERMARK_WIDTH_RATIO,
        ) {
            return Err("a watermark width is out of range".into());
        }

        Ok(self)
    }
}

fn in_range(value: f32, minimum: f32, maximum: f32) -> bool {
    value.is_finite() && (minimum..=maximum).contains(&value)
}

fn is_usable_size(value: f32) -> bool {
    value.is_finite() && value > 0.0
}

/// The page's own diagonal, so a full-width mark runs corner to corner at any
/// sheet proportions.
pub(super) fn watermark_rotation(
    direction: WatermarkDirection,
    display_width: f32,
    display_height: f32,
) -> Result<f32, String> {
    if !is_usable_size(display_width) || !is_usable_size(display_height) {
        return Err("a watermark needs a finite positive page size".into());
    }

    let diagonal = (display_height / display_width).atan().to_degrees();

    Ok(match direction {
        // Turning clockwise drops the text's right end, which is the descending
        // corner-to-corner direction; the ascending one is its mirror.
        WatermarkDirection::Ascending => -diagonal,
        WatermarkDirection::Descending => diagonal,
    })
}

/// Text bounds scale with the size, so one measured width at the reference size
/// fixes the size for any target share.
pub(super) fn watermark_font_size(
    width_ratio: f32,
    display_width: f32,
    measured_width: f32,
) -> Result<f32, String> {
    if !is_usable_size(display_width) || !is_usable_size(measured_width) {
        return Err("a watermark could not be measured on this page".into());
    }

    let size = WATERMARK_REFERENCE_FONT_SIZE * width_ratio * display_width / measured_width;

    if !size.is_finite() {
        return Err("a watermark size could not be derived for this page".into());
    }

    Ok(size.clamp(MIN_WATERMARK_FONT_SIZE, MAX_WATERMARK_FONT_SIZE))
}

pub(super) fn watermark_zebra_spacing(font_size: f32) -> f32 {
    font_size * WATERMARK_ZEBRA_GAP_RATIO
}

/// Clamped, so a hair's-breadth step keeps its meaning: the per-page object
/// limit is what actually stops a grid that fine.
fn steps_to_cover(distance: f32, step: f32) -> i32 {
    let steps = (distance / step).ceil();

    if steps.is_finite() {
        steps.clamp(0.0, MAX_WATERMARK_OBJECTS_PER_PAGE as f32) as i32
    } else {
        MAX_WATERMARK_OBJECTS_PER_PAGE as i32
    }
}

pub(super) fn add_document_object_count(
    current: usize,
    additional: usize,
) -> Result<usize, String> {
    let total = current
        .checked_add(additional)
        .ok_or_else(|| "the watermark document object count overflowed".to_string())?;

    if total > MAX_WATERMARK_DOCUMENT_OBJECTS {
        return Err(format!(
            "a watermark may create at most {MAX_WATERMARK_DOCUMENT_OBJECTS} objects per document"
        ));
    }

    Ok(total)
}

/// The caller measures the already-rotated text, so these steps describe what
/// readers see, not the unrotated font box.
pub(super) fn watermark_placements(
    page_width: f32,
    page_height: f32,
    text_width: f32,
    text_height: f32,
    spacing: f32,
    layout: WatermarkLayout,
) -> Result<Vec<WatermarkPlacement>, String> {
    if ![page_width, page_height, text_width, text_height]
        .iter()
        .all(|value| is_usable_size(*value))
    {
        return Err("a watermark needs finite positive page and text bounds".into());
    }

    if layout == WatermarkLayout::Single {
        return Ok(vec![WatermarkPlacement {
            center_x: page_width / 2.0,
            center_y: page_height / 2.0,
        }]);
    }

    let step_x = text_width + spacing;
    let step_y = text_height + spacing;

    if ![step_x, step_y].iter().all(|value| is_usable_size(*value)) {
        return Err("a watermark grid has an unusable step".into());
    }

    // Laid out from the middle, so a mark too big to repeat still leaves one
    // whole copy where a single mark would have been.
    let middle_x = page_width / 2.0;
    let middle_y = page_height / 2.0;
    let columns = steps_to_cover(middle_x + text_width, step_x);
    let rows = steps_to_cover(middle_y + text_height, step_y);
    let mut placements = Vec::new();

    for row in -rows..=rows {
        // Odd rows shift half a step right, costing that half at the left edge;
        // the extra column covers it.
        let offset = if row % 2 == 0 { 0.0 } else { step_x / 2.0 };

        for column in -columns - 1..=columns {
            if placements.len() == MAX_WATERMARK_OBJECTS_PER_PAGE {
                return Err(format!(
                    "a watermark may create at most {MAX_WATERMARK_OBJECTS_PER_PAGE} objects per page"
                ));
            }

            placements.push(WatermarkPlacement {
                center_x: middle_x + column as f32 * step_x + offset,
                center_y: middle_y + row as f32 * step_y,
            });
        }
    }

    if placements.is_empty() {
        return Err("a watermark grid did not produce any objects".into());
    }

    Ok(placements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> WatermarkConfig {
        WatermarkConfig {
            rasterize: false,
            text: "CONFIDENTIAL".into(),
            width_ratio: 0.8,
            direction: WatermarkDirection::Ascending,
            layout: WatermarkLayout::Zebra,
        }
    }

    #[test]
    fn accepts_every_watermark_range_endpoint() {
        for width_ratio in [MIN_WATERMARK_WIDTH_RATIO, MAX_WATERMARK_WIDTH_RATIO] {
            let mut value = config();
            value.width_ratio = width_ratio;

            assert!(value.validated().is_ok());
        }
    }

    #[test]
    fn rejects_unusable_watermark_values() {
        type Change = Box<dyn Fn(&mut WatermarkConfig)>;

        let changes: Vec<Change> = vec![
            Box::new(|value| value.text = "   ".into()),
            Box::new(|value| value.text = "two\nlines".into()),
            Box::new(|value| value.text = "x".repeat(MAX_WATERMARK_CHARS + 1)),
            Box::new(|value| value.width_ratio = f32::NAN),
            Box::new(|value| value.width_ratio = MIN_WATERMARK_WIDTH_RATIO - 0.01),
            Box::new(|value| value.width_ratio = MAX_WATERMARK_WIDTH_RATIO + 0.01),
        ];

        for change in changes {
            let mut value = config();
            change(&mut value);
            assert!(value.validated().is_err());
        }
    }

    #[test]
    fn the_two_directions_follow_the_page_diagonal() {
        let ascending = watermark_rotation(WatermarkDirection::Ascending, 600.0, 800.0).unwrap();
        let descending = watermark_rotation(WatermarkDirection::Descending, 600.0, 800.0).unwrap();

        assert!((ascending + 53.13).abs() < 0.01);
        assert_eq!(descending, -ascending);
        // A landscape sheet leans by as much as it is wide, not by a fixed angle.
        assert!(
            watermark_rotation(WatermarkDirection::Descending, 800.0, 600.0).unwrap() < descending
        );
        assert!(watermark_rotation(WatermarkDirection::Ascending, 0.0, 800.0).is_err());
    }

    #[test]
    fn the_derived_size_scales_the_measured_mark_to_the_asked_share() {
        assert_eq!(
            watermark_font_size(1.0, 600.0, 300.0).unwrap(),
            WATERMARK_REFERENCE_FONT_SIZE * 2.0
        );
        assert_eq!(
            watermark_font_size(0.5, 600.0, 300.0).unwrap(),
            WATERMARK_REFERENCE_FONT_SIZE
        );
        assert_eq!(
            watermark_font_size(1.0, 600.0, 0.001).unwrap(),
            MAX_WATERMARK_FONT_SIZE
        );
        assert!(watermark_font_size(0.8, 600.0, 0.0).is_err());
        assert!(watermark_font_size(0.8, f32::NAN, 300.0).is_err());
    }

    #[test]
    fn single_watermark_is_centered() {
        assert_eq!(
            watermark_placements(600.0, 800.0, 180.0, 40.0, 54.0, WatermarkLayout::Single).unwrap(),
            vec![WatermarkPlacement {
                center_x: 300.0,
                center_y: 400.0,
            }]
        );
    }

    #[test]
    fn zebra_hangs_its_grid_on_the_page_centre() {
        let spacing = 54.0;
        let placements =
            watermark_placements(600.0, 800.0, 180.0, 40.0, spacing, WatermarkLayout::Zebra)
                .unwrap();
        let step_x = 180.0 + spacing;
        let middle = WatermarkPlacement {
            center_x: 300.0,
            center_y: 400.0,
        };

        // Where a single mark would have gone, so switching to a repeat never
        // moves the copy the reader was already looking at.
        assert!(placements.contains(&middle));
        assert!(placements.iter().any(|placement| placement.center_x
            == middle.center_x + step_x / 2.0
            && placement.center_y > middle.center_y));
        assert!(placements.iter().any(|placement| placement.center_x < 0.0));
        assert!(placements
            .iter()
            .any(|placement| placement.center_x > 600.0));
        assert!(placements.iter().any(|placement| placement.center_y < 0.0));
        assert!(placements
            .iter()
            .any(|placement| placement.center_y > 800.0));
    }

    #[test]
    fn a_mark_too_big_to_repeat_still_leaves_one_whole_copy() {
        let placements =
            watermark_placements(600.0, 800.0, 900.0, 500.0, 100.0, WatermarkLayout::Zebra)
                .unwrap();

        assert!(placements.contains(&WatermarkPlacement {
            center_x: 300.0,
            center_y: 400.0,
        }));
    }

    #[test]
    fn rejects_a_grid_over_the_per_page_object_limit() {
        assert!(watermark_placements(
            14_400.0,
            14_400.0,
            1.0,
            1.0,
            MIN_WATERMARK_FONT_SIZE,
            WatermarkLayout::Zebra
        )
        .is_err());
    }

    #[test]
    fn rejects_a_grid_over_the_document_object_limit() {
        assert_eq!(
            add_document_object_count(MAX_WATERMARK_DOCUMENT_OBJECTS - 1, 1).unwrap(),
            MAX_WATERMARK_DOCUMENT_OBJECTS
        );
        assert!(add_document_object_count(MAX_WATERMARK_DOCUMENT_OBJECTS, 1).is_err());
        assert!(add_document_object_count(usize::MAX, 1).is_err());
    }
}
