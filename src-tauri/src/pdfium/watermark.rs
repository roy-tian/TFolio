use serde::{Deserialize, Serialize};

pub(super) const MAX_WATERMARK_CHARS: usize = 256;
pub(super) const MAX_WATERMARK_DOCUMENT_OBJECTS: usize = 20_000;
pub(super) const MAX_WATERMARK_FONT_SIZE: f32 = 144.0;
pub(super) const MAX_WATERMARK_OBJECTS_PER_PAGE: usize = 512;
pub(super) const MAX_WATERMARK_SPACING: f32 = 240.0;
pub(super) const MIN_WATERMARK_FONT_SIZE: f32 = 6.0;
pub(super) const MIN_WATERMARK_OPACITY: f32 = 0.05;
pub(super) const MIN_WATERMARK_SPACING: f32 = 12.0;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkConfig {
    pub(super) text: String,
    pub(super) font_family: WatermarkFontFamily,
    pub(super) font_size: f32,
    pub(super) color: String,
    pub(super) opacity: f32,
    /// Clockwise degrees relative to the page's normal displayed direction.
    pub(super) rotation: f32,
    pub(super) layout: WatermarkLayout,
    /// The gap between tiles on both axes; the grid steps by the text box plus
    /// this, so the two directions read as one density to the reader.
    pub(super) spacing: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WatermarkFontFamily {
    Sans,
    Serif,
    Mono,
}

impl WatermarkFontFamily {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Sans => "sans",
            Self::Serif => "serif",
            Self::Mono => "mono",
        }
    }
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
    /// Validates every value that crossed the WebView boundary and returns a
    /// canonical rotation, so equivalent directions compare equal in history
    /// and in the backend's replace no-op.
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
        if !is_hex_color(&self.color) {
            return Err("a watermark colour must be a six-digit hex value".into());
        }
        if !in_range(
            self.font_size,
            MIN_WATERMARK_FONT_SIZE,
            MAX_WATERMARK_FONT_SIZE,
        ) {
            return Err("a watermark font size is out of range".into());
        }
        if !in_range(self.opacity, MIN_WATERMARK_OPACITY, 1.0) {
            return Err("a watermark opacity is out of range".into());
        }
        if !self.rotation.is_finite() {
            return Err("a watermark rotation must be finite".into());
        }
        if !in_range(self.spacing, MIN_WATERMARK_SPACING, MAX_WATERMARK_SPACING) {
            return Err("a watermark spacing is out of range".into());
        }

        self.rotation = normalize_rotation(self.rotation);

        Ok(self)
    }
}

fn in_range(value: f32, minimum: f32, maximum: f32) -> bool {
    value.is_finite() && (minimum..=maximum).contains(&value)
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..]
            .iter()
            .all(|character| character.is_ascii_hexdigit())
}

pub(super) fn normalize_rotation(rotation: f32) -> f32 {
    let normalized = rotation.rem_euclid(360.0);

    if normalized > 180.0 {
        normalized - 360.0
    } else {
        normalized
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

/// Produces target centres in unrotated page space. The caller measures the
/// already-rotated text first, so these steps describe what readers actually
/// see rather than the unrotated font box.
pub(super) fn watermark_placements(
    page_width: f32,
    page_height: f32,
    text_width: f32,
    text_height: f32,
    config: &WatermarkConfig,
) -> Result<Vec<WatermarkPlacement>, String> {
    if ![page_width, page_height, text_width, text_height]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        return Err("a watermark needs finite positive page and text bounds".into());
    }

    if config.layout == WatermarkLayout::Single {
        return Ok(vec![WatermarkPlacement {
            center_x: page_width / 2.0,
            center_y: page_height / 2.0,
        }]);
    }

    let step_x = text_width + config.spacing;
    let step_y = text_height + config.spacing;

    if ![step_x, step_y]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        return Err("a watermark grid has an unusable step".into());
    }

    let mut placements = Vec::new();
    let mut row = 0usize;
    let mut center_y = -text_height;

    while center_y <= page_height + text_height {
        let offset = if row % 2 == 0 { 0.0 } else { step_x / 2.0 };
        let mut center_x = -text_width + offset;

        while center_x <= page_width + text_width {
            if placements.len() == MAX_WATERMARK_OBJECTS_PER_PAGE {
                return Err(format!(
                    "a watermark may create at most {MAX_WATERMARK_OBJECTS_PER_PAGE} objects per page"
                ));
            }

            placements.push(WatermarkPlacement { center_x, center_y });
            center_x += step_x;
        }

        row = row
            .checked_add(1)
            .ok_or_else(|| "a watermark grid has too many rows".to_string())?;
        center_y += step_y;
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
            text: "CONFIDENTIAL".into(),
            font_family: WatermarkFontFamily::Sans,
            font_size: 36.0,
            color: "#64748b".into(),
            opacity: 0.25,
            rotation: -30.0,
            layout: WatermarkLayout::Zebra,
            spacing: 54.0,
        }
    }

    #[test]
    fn accepts_every_watermark_range_endpoint() {
        for (font_size, opacity, spacing) in [
            (
                MIN_WATERMARK_FONT_SIZE,
                MIN_WATERMARK_OPACITY,
                MIN_WATERMARK_SPACING,
            ),
            (MAX_WATERMARK_FONT_SIZE, 1.0, MAX_WATERMARK_SPACING),
        ] {
            let mut value = config();
            value.font_size = font_size;
            value.opacity = opacity;
            value.spacing = spacing;

            assert!(value.validated().is_ok());
        }
    }

    #[test]
    fn rejects_unusable_watermark_values() {
        let changes: Vec<Box<dyn Fn(&mut WatermarkConfig)>> = vec![
            Box::new(|value| value.text = "   ".into()),
            Box::new(|value| value.text = "two\nlines".into()),
            Box::new(|value| value.text = "x".repeat(MAX_WATERMARK_CHARS + 1)),
            Box::new(|value| value.color = "red".into()),
            Box::new(|value| value.font_size = f32::NAN),
            Box::new(|value| value.font_size = MIN_WATERMARK_FONT_SIZE - 0.1),
            Box::new(|value| value.opacity = f32::INFINITY),
            Box::new(|value| value.opacity = MIN_WATERMARK_OPACITY - 0.01),
            Box::new(|value| value.rotation = f32::NEG_INFINITY),
            Box::new(|value| value.spacing = MIN_WATERMARK_SPACING - 0.1),
            Box::new(|value| value.spacing = MAX_WATERMARK_SPACING + 0.1),
        ];

        for change in changes {
            let mut value = config();
            change(&mut value);
            assert!(value.validated().is_err());
        }
    }

    #[test]
    fn normalizes_equivalent_rotations() {
        assert_eq!(normalize_rotation(0.0), 0.0);
        assert_eq!(normalize_rotation(360.0), 0.0);
        assert_eq!(normalize_rotation(540.0), 180.0);
        assert_eq!(normalize_rotation(181.0), -179.0);
        assert_eq!(normalize_rotation(-181.0), 179.0);
    }

    #[test]
    fn single_watermark_is_centered() {
        let mut value = config();
        value.layout = WatermarkLayout::Single;

        assert_eq!(
            watermark_placements(600.0, 800.0, 180.0, 40.0, &value).unwrap(),
            vec![WatermarkPlacement {
                center_x: 300.0,
                center_y: 400.0,
            }]
        );
    }

    #[test]
    fn zebra_rows_are_staggered_by_half_a_step() {
        let value = config();
        let placements = watermark_placements(600.0, 800.0, 180.0, 40.0, &value).unwrap();
        let step_x = 180.0 + value.spacing;
        let first_y = placements[0].center_y;
        let second_row = placements
            .iter()
            .find(|placement| placement.center_y > first_y)
            .unwrap();

        assert_eq!(placements[0].center_x, -180.0);
        assert_eq!(second_row.center_x, -180.0 + step_x / 2.0);
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
    fn rejects_a_grid_over_the_per_page_object_limit() {
        let mut value = config();
        value.font_size = MIN_WATERMARK_FONT_SIZE;
        value.spacing = MIN_WATERMARK_SPACING;

        assert!(watermark_placements(14_400.0, 14_400.0, 1.0, 1.0, &value).is_err());
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
