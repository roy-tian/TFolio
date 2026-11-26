use serde::{Deserialize, Serialize};

/// Not exposed in the dialog; a double-sided contract mirrored by
/// `src/lib/pageNumbers.ts`.
pub(super) const FONT_SIZE: f32 = 11.0;
/// Measured in display space, so a `/Rotate`d page still counts from the edge
/// the reader sees at the bottom.
pub(super) const BOTTOM_MARGIN: f32 = 51.02;
pub(super) const SIDE_MARGIN: f32 = 72.0;
/// A double-sided contract with the frontend.
pub(super) const MAX_START: i32 = 99_999;
const LUMINANCE_THRESHOLD: f32 = 0.5;
/// Well above the smart-colour threshold: the question is "did anything print",
/// not "is this dark".
const BLANK_INK_LUMINANCE: f32 = 0.9;
/// The share of sampled pixels that may still be ink on a page called blank, so
/// a stray speck does not count as content while short text on A4 still does.
const BLANK_INK_TOLERANCE: f32 = 0.0001;

const WHITE_INK: &str = "#FFFFFF";
const BLACK_INK: &str = "#000000";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageNumbersConfig {
    pub(super) mode: PageNumbersMode,
    /// Used only by `Single`; ignored for `Duplex`, which mirrors by page parity.
    pub(super) position: PageNumbersPosition,
    pub(super) range: Option<(i32, i32)>,
    pub(super) start: Option<i32>,
    pub(super) smart_color: bool,
    /// Reading it costs a render per page, so both flags on skips the test.
    pub(super) blank_numbered: bool,
    /// A page that takes no number has nothing to print, so this off implies
    /// `blank_numbered` off.
    pub(super) blank_counted: bool,
}

/// What `settings.rs` keeps between runs, mirrored by `PageNumbersPreferences`
/// in `src/lib/pageNumbers.ts`; the range and start stay per-document.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageNumbersPreferences {
    pub mode: PageNumbersMode,
    pub position: PageNumbersPosition,
    pub smart_color: bool,
    pub blank_numbered: bool,
    pub blank_counted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PageNumbersMode {
    Single,
    Duplex,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PageNumbersPosition {
    BottomCenter,
    BottomRight,
}

// Every anchor is along the bottom edge, so the shared prefix is the point.
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PageNumberAnchor {
    BottomCenter,
    BottomRight,
    BottomLeft,
}

/// The label a padding blank between files carries when page numbers include
/// and show numbers on blank pages: shown in the viewer, printed, and stamped
/// when a Save As or A4 copy inserts the sheet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaddingPageNumber {
    pub text: String,
    pub anchor: PageNumberAnchor,
}

/// Unrotated page space, the same space `WatermarkPlacement` uses, so one
/// placement helper can position both.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PageNumberPlacement {
    pub(super) center_x: f32,
    pub(super) center_y: f32,
}

/// A number's box in display space with a top-left origin — the coordinate
/// system a rendered bitmap uses, so the smart-colour sampler can crop it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DisplayBox {
    pub(super) left: f32,
    pub(super) top: f32,
    pub(super) width: f32,
    pub(super) height: f32,
}

impl PageNumbersConfig {
    /// Enums are guaranteed by serde, and there is no page cap because one page
    /// takes exactly one object.
    pub(super) fn validated(self, page_count: i32) -> Result<Self, String> {
        if let Some((from, to)) = self.range {
            if !(from >= 1 && from <= to && to <= page_count) {
                return Err("a page-number range must fall within the document".into());
            }
        }

        if let Some(start) = self.start {
            if !(1..=MAX_START).contains(&start) {
                return Err(format!(
                    "a starting page number must be between 1 and {MAX_START}"
                ));
            }
        }

        Ok(self)
    }

    pub(super) fn smart_color(&self) -> bool {
        self.smart_color
    }

    pub(super) fn covers(&self, page_number: i32) -> bool {
        match self.range {
            Some((from, to)) => page_number >= from && page_number <= to,
            None => true,
        }
    }

    /// A padding blank after 1-based `after` lies between `after` and
    /// `after + 1`, so it falls inside the range only when both sides do.
    pub(super) fn covers_padding_after(&self, after: i32) -> bool {
        match self.range {
            Some((from, to)) => after >= from && after < to,
            None => true,
        }
    }

    pub(super) fn range_from(&self) -> i32 {
        self.range.map_or(1, |(from, _)| from)
    }

    pub(super) fn needs_blank_scan(&self) -> bool {
        !self.blank_numbered || !self.blank_counted
    }

    /// `Duplex` odd/even follows the physical page — the binding side — not the
    /// printed number, which a custom start can shift out of step.
    pub(super) fn anchor(&self, page_number: i32) -> PageNumberAnchor {
        match self.mode {
            PageNumbersMode::Single => match self.position {
                PageNumbersPosition::BottomCenter => PageNumberAnchor::BottomCenter,
                PageNumbersPosition::BottomRight => PageNumberAnchor::BottomRight,
            },
            PageNumbersMode::Duplex => {
                if page_number % 2 == 1 {
                    PageNumberAnchor::BottomRight
                } else {
                    PageNumberAnchor::BottomLeft
                }
            }
        }
    }
}

fn label(printed: i32) -> String {
    format!("— {printed} —")
}

/// A walk rather than a formula: a blank page may take no number, so what a
/// page prints depends on the pages before it.
pub(super) struct PageNumbering<'a> {
    config: &'a PageNumbersConfig,
    next: i32,
}

impl<'a> PageNumbering<'a> {
    pub(super) fn new_from(config: &'a PageNumbersConfig, first_sheet: i32) -> Self {
        Self {
            next: config.start.unwrap_or(first_sheet),
            config,
        }
    }

    #[cfg(test)]
    pub(super) fn new(config: &'a PageNumbersConfig) -> Self {
        Self::new_from(config, config.range_from())
    }

    pub(super) fn advance(&mut self, page_number: i32, blank: bool) -> Option<String> {
        if !self.config.covers(page_number) || (blank && !self.config.blank_counted) {
            return None;
        }

        let printed = self.next;
        self.next += 1;

        (!blank || self.config.blank_numbered).then(|| label(printed))
    }

    /// Advances over a virtual padding blank after 1-based `after_page_number`.
    /// Counted and optionally printed under the same blank-page rules as a
    /// real blank page inside the range.
    pub(super) fn advance_padding(&mut self, after_page_number: i32) -> Option<String> {
        if !self.config.covers_padding_after(after_page_number) || !self.config.blank_counted {
            return None;
        }

        let printed = self.next;
        self.next += 1;

        self.config.blank_numbered.then(|| label(printed))
    }
}

/// Pixels are composited over white first, so a page whose only "content" is
/// transparent still reads blank.
pub(super) fn is_blank_sample(rgba: &[u8]) -> bool {
    let mut ink = 0u32;
    let mut count = 0u32;

    for pixel in rgba.as_chunks::<4>().0 {
        let alpha = pixel[3] as f32 / 255.0;
        let luminance = (1.0 - alpha) + alpha * relative_luminance(pixel[0], pixel[1], pixel[2]);

        if luminance < BLANK_INK_LUMINANCE {
            ink += 1;
        }
        count += 1;
    }

    ink as f32 <= count as f32 * BLANK_INK_TOLERANCE
}

fn upright_text_size(rotation: f32, bounds_width: f32, bounds_height: f32) -> (f32, f32) {
    match rotation as i32 {
        90 | 270 => (bounds_height, bounds_width),
        _ => (bounds_width, bounds_height),
    }
}

fn display_size(rotation: f32, unrotated_width: f32, unrotated_height: f32) -> (f32, f32) {
    match rotation as i32 {
        90 | 270 => (unrotated_height, unrotated_width),
        _ => (unrotated_width, unrotated_height),
    }
}

fn display_center(
    display_width: f32,
    display_height: f32,
    text_width: f32,
    text_height: f32,
    anchor: PageNumberAnchor,
) -> (f32, f32) {
    // Clamp margins on unusually narrow or short pages so side anchors never
    // cross each other or clip outside the visible sheet.
    let bottom_margin = BOTTOM_MARGIN.min(((display_height - text_height) / 2.0).max(0.0));
    let side_margin = SIDE_MARGIN.min(((display_width - text_width) / 2.0).max(0.0));
    let center_y = bottom_margin + text_height / 2.0;
    let center_x = match anchor {
        PageNumberAnchor::BottomCenter => display_width / 2.0,
        PageNumberAnchor::BottomRight => display_width - side_margin - text_width / 2.0,
        PageNumberAnchor::BottomLeft => side_margin + text_width / 2.0,
    };

    (center_x, center_y)
}

/// The inverse of the `/Rotate` a render applies, offset by the visible page
/// box's unrotated origin, so the number lands upright inside cropped pages too.
#[allow(clippy::too_many_arguments)]
pub(super) fn page_number_center_in_box(
    origin_x: f32,
    origin_y: f32,
    unrotated_width: f32,
    unrotated_height: f32,
    rotation: f32,
    bounds_width: f32,
    bounds_height: f32,
    anchor: PageNumberAnchor,
) -> PageNumberPlacement {
    let (display_width, display_height) = display_size(rotation, unrotated_width, unrotated_height);
    let (text_width, text_height) = upright_text_size(rotation, bounds_width, bounds_height);
    let (center_x, center_y) = display_center(
        display_width,
        display_height,
        text_width,
        text_height,
        anchor,
    );

    let (unrotated_x, unrotated_y) = match rotation as i32 {
        90 => (unrotated_width - center_y, center_x),
        180 => (unrotated_width - center_x, unrotated_height - center_y),
        270 => (center_y, unrotated_height - center_x),
        _ => (center_x, center_y),
    };

    PageNumberPlacement {
        center_x: origin_x + unrotated_x,
        center_y: origin_y + unrotated_y,
    }
}

#[cfg(test)]
pub(super) fn page_number_center(
    unrotated_width: f32,
    unrotated_height: f32,
    rotation: f32,
    bounds_width: f32,
    bounds_height: f32,
    anchor: PageNumberAnchor,
) -> PageNumberPlacement {
    page_number_center_in_box(
        0.0,
        0.0,
        unrotated_width,
        unrotated_height,
        rotation,
        bounds_width,
        bounds_height,
        anchor,
    )
}

pub(super) fn page_number_display_box(
    unrotated_width: f32,
    unrotated_height: f32,
    rotation: f32,
    bounds_width: f32,
    bounds_height: f32,
    anchor: PageNumberAnchor,
) -> DisplayBox {
    let (display_width, display_height) = display_size(rotation, unrotated_width, unrotated_height);
    let (text_width, text_height) = upright_text_size(rotation, bounds_width, bounds_height);
    let (center_x, center_y) = display_center(
        display_width,
        display_height,
        text_width,
        text_height,
        anchor,
    );

    DisplayBox {
        left: center_x - text_width / 2.0,
        // The bottom-left centre_y counts up from the bottom; a top-left box
        // counts down from the top.
        top: display_height - (center_y + text_height / 2.0),
        width: text_width,
        height: text_height,
    }
}

/// One pixel's relative luminance, Rec. 709 weighted, in 0..1.
pub(super) fn relative_luminance(red: u8, green: u8, blue: u8) -> f32 {
    (0.2126 * red as f32 + 0.7152 * green as f32 + 0.0722 * blue as f32) / 255.0
}

/// The mean relative luminance of a run of RGBA pixels, composited over white.
/// An empty run reads as light, so an unsampled number stays black.
pub(super) fn average_luminance(rgba: &[u8]) -> f32 {
    let mut sum = 0.0f32;
    let mut count = 0u32;

    for pixel in rgba.as_chunks::<4>().0 {
        let alpha = pixel[3] as f32 / 255.0;
        sum += (1.0 - alpha) + alpha * relative_luminance(pixel[0], pixel[1], pixel[2]);
        count += 1;
    }

    if count == 0 {
        1.0
    } else {
        sum / count as f32
    }
}

pub(super) fn ink_color(average_luminance: f32) -> &'static str {
    if average_luminance < LUMINANCE_THRESHOLD {
        WHITE_INK
    } else {
        BLACK_INK
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PageNumbersConfig {
        PageNumbersConfig {
            mode: PageNumbersMode::Single,
            position: PageNumbersPosition::BottomCenter,
            range: None,
            start: None,
            smart_color: true,
            blank_numbered: true,
            blank_counted: true,
        }
    }

    fn walk(config: &PageNumbersConfig, blanks: &[bool]) -> Vec<Option<String>> {
        let mut numbering = PageNumbering::new(config);

        blanks
            .iter()
            .enumerate()
            .map(|(index, blank)| numbering.advance(index as i32 + 1, *blank))
            .collect()
    }

    fn labels(config: &PageNumbersConfig, pages: usize) -> Vec<Option<String>> {
        walk(config, &vec![false; pages])
    }

    #[test]
    fn accepts_a_range_and_start_within_bounds() {
        let mut value = config();
        value.range = Some((1, 10));
        value.start = Some(1);
        assert!(value.validated(10).is_ok());

        let mut edge = config();
        edge.range = Some((10, 10));
        edge.start = Some(MAX_START);
        assert!(edge.validated(10).is_ok());
    }

    #[test]
    fn rejects_unusable_ranges_and_starts() {
        type Change = Box<dyn Fn(&mut PageNumbersConfig)>;

        let cases: Vec<(Change, i32)> = vec![
            (Box::new(|value| value.range = Some((0, 5))), 10),
            (Box::new(|value| value.range = Some((5, 4))), 10),
            (Box::new(|value| value.range = Some((1, 11))), 10),
            (Box::new(|value| value.start = Some(0)), 10),
            (Box::new(|value| value.start = Some(-1)), 10),
            (Box::new(|value| value.start = Some(MAX_START + 1)), 10),
        ];

        for (change, page_count) in cases {
            let mut value = config();
            change(&mut value);
            assert!(value.validated(page_count).is_err());
        }
    }

    #[test]
    fn custom_start_renumbers_from_the_range_first_page() {
        let mut value = config();
        value.range = Some((2, 4));
        value.start = Some(10);

        assert_eq!(
            labels(&value, 5),
            vec![
                None,
                Some("— 10 —".to_string()),
                Some("— 11 —".to_string()),
                Some("— 12 —".to_string()),
                None
            ]
        );
    }

    #[test]
    fn blank_pages_follow_the_two_rules_they_are_given() {
        let blanks = [false, true, false];

        let both = config();
        assert!(!both.needs_blank_scan());
        assert_eq!(
            walk(&both, &blanks),
            vec![
                Some("— 1 —".to_string()),
                Some("— 2 —".to_string()),
                Some("— 3 —".to_string())
            ]
        );

        let mut counted = config();
        counted.blank_numbered = false;
        assert!(counted.needs_blank_scan());
        assert_eq!(
            walk(&counted, &blanks),
            vec![Some("— 1 —".to_string()), None, Some("— 3 —".to_string())]
        );

        let mut skipped = config();
        skipped.blank_numbered = false;
        skipped.blank_counted = false;
        assert_eq!(
            walk(&skipped, &blanks),
            vec![Some("— 1 —".to_string()), None, Some("— 2 —".to_string())]
        );

        // "Numbered but not counted" has no number to print, so it prints none.
        let mut incoherent = config();
        incoherent.blank_counted = false;
        assert_eq!(
            walk(&incoherent, &blanks),
            vec![Some("— 1 —".to_string()), None, Some("— 2 —".to_string())]
        );
    }

    #[test]
    fn a_blank_page_outside_the_range_costs_the_sequence_nothing() {
        let mut value = config();
        value.range = Some((2, 4));
        value.blank_numbered = false;
        value.blank_counted = false;

        assert_eq!(
            walk(&value, &[true, false, true, false, true]),
            vec![
                None,
                Some("— 2 —".to_string()),
                None,
                Some("— 3 —".to_string()),
                None
            ]
        );
    }

    #[test]
    fn padding_blanks_follow_the_blank_page_rules_and_range() {
        let mut show = config();
        let mut numbering = PageNumbering::new_from(&show, 1);
        assert_eq!(numbering.advance(1, false), Some("— 1 —".to_string()));
        assert_eq!(numbering.advance_padding(1), Some("— 2 —".to_string()));
        assert_eq!(numbering.advance(2, false), Some("— 3 —".to_string()));

        let mut hide = config();
        hide.blank_numbered = false;
        let mut numbering = PageNumbering::new_from(&hide, 1);
        assert_eq!(numbering.advance(1, false), Some("— 1 —".to_string()));
        assert_eq!(numbering.advance_padding(1), None);
        assert_eq!(numbering.advance(2, false), Some("— 3 —".to_string()));

        let mut skip = config();
        skip.blank_numbered = false;
        skip.blank_counted = false;
        let mut numbering = PageNumbering::new_from(&skip, 1);
        assert_eq!(numbering.advance(1, false), Some("— 1 —".to_string()));
        assert_eq!(numbering.advance_padding(1), None);
        assert_eq!(numbering.advance(2, false), Some("— 2 —".to_string()));

        // A padding blank outside the range is neither counted nor printed.
        show.range = Some((2, 3));
        assert!(!show.covers_padding_after(1));
        assert!(show.covers_padding_after(2));
        assert!(!show.covers_padding_after(3));
    }

    #[test]
    fn a_page_is_blank_until_something_prints_on_it() {
        let white = [255u8, 255, 255, 255].repeat(10_000);
        assert!(is_blank_sample(&white));
        // Nothing sampled at all is blank rather than a failure.
        assert!(is_blank_sample(&[]));

        // Transparent pixels are composited over white before they are read.
        assert!(is_blank_sample(&[0, 0, 0, 0].repeat(10_000)));

        // A tolerance of stray dark pixels, while short text still clears it.
        let mut speck = white.clone();
        speck[0..4].copy_from_slice(&[0, 0, 0, 255]);
        assert!(is_blank_sample(&speck));

        let mut printed = white.clone();
        for pixel in printed.as_chunks_mut::<4>().0.iter_mut().take(10) {
            pixel.copy_from_slice(&[0, 0, 0, 255]);
        }
        assert!(!is_blank_sample(&printed));

        // Pale grey is still paper; mid grey is ink.
        assert!(is_blank_sample(&[250, 250, 250, 255].repeat(1000)));
        assert!(!is_blank_sample(&[180, 180, 180, 255].repeat(1000)));
    }

    #[test]
    fn duplex_mirrors_by_physical_page_not_printed_number() {
        let mut value = config();
        value.mode = PageNumbersMode::Duplex;
        value.range = Some((2, 5));
        value.start = Some(10);

        // Page 2 prints "10" — an even number — but sits on the left because it
        // is the second physical page. The side follows the binding, not the ink.
        assert_eq!(
            PageNumbering::new(&value).advance(2, false),
            Some("— 10 —".to_string())
        );
        assert_eq!(value.anchor(2), PageNumberAnchor::BottomLeft);
        assert_eq!(value.anchor(3), PageNumberAnchor::BottomRight);
    }

    #[test]
    fn single_mode_uses_the_chosen_position_everywhere() {
        let mut value = config();
        value.position = PageNumbersPosition::BottomRight;
        assert_eq!(value.anchor(1), PageNumberAnchor::BottomRight);
        assert_eq!(value.anchor(2), PageNumberAnchor::BottomRight);
    }

    #[test]
    fn centers_along_the_bottom_on_an_upright_page() {
        let placement = page_number_center(
            600.0,
            800.0,
            0.0,
            40.0,
            11.0,
            PageNumberAnchor::BottomCenter,
        );

        assert!((placement.center_x - 300.0).abs() < 1e-3);
        assert!((placement.center_y - (BOTTOM_MARGIN + 5.5)).abs() < 1e-3);
    }

    #[test]
    fn right_and_left_anchors_sit_a_side_margin_in() {
        let right =
            page_number_center(600.0, 800.0, 0.0, 40.0, 11.0, PageNumberAnchor::BottomRight);
        // The box's right edge sits SIDE_MARGIN from the page's right edge.
        assert!((right.center_x + 20.0 - (600.0 - SIDE_MARGIN)).abs() < 1e-3);

        let left = page_number_center(600.0, 800.0, 0.0, 40.0, 11.0, PageNumberAnchor::BottomLeft);
        assert!((left.center_x - 20.0 - SIDE_MARGIN).abs() < 1e-3);
    }

    #[test]
    fn right_and_left_anchors_track_the_display_edges_on_a_rotated_page() {
        // Only a side anchor makes text_width enter the horizontal placement, so
        // this is the case the bottom-centre rotation test cannot catch.
        let right = page_number_center(
            600.0,
            800.0,
            90.0,
            11.0,
            40.0,
            PageNumberAnchor::BottomRight,
        );
        let left = page_number_center(600.0, 800.0, 90.0, 11.0, 40.0, PageNumberAnchor::BottomLeft);

        // Both sit the same distance up from the display bottom — the unrotated
        // x a 90° turn maps onto the displayed bottom edge.
        let up_from_bottom = 600.0 - (BOTTOM_MARGIN + 5.5);
        assert!((right.center_x - up_from_bottom).abs() < 1e-3);
        assert!((left.center_x - up_from_bottom).abs() < 1e-3);

        // The displayed side edges are the unrotated y-axis: each anchor lands
        // a side margin in from its edge, pulled in by half the label width.
        assert!((right.center_y - (800.0 - SIDE_MARGIN - 20.0)).abs() < 1e-3);
        assert!((left.center_y - (SIDE_MARGIN + 20.0)).abs() < 1e-3);
    }

    #[test]
    fn places_the_number_in_display_space_on_a_rotated_page() {
        // The bottom-centre number must land where the reader sees the bottom,
        // whichever way the page is turned.
        for rotation in [0.0, 90.0, 180.0, 270.0] {
            let sideways = rotation == 90.0 || rotation == 270.0;
            let (unrotated_width, unrotated_height) = if sideways {
                (800.0, 600.0)
            } else {
                (600.0, 800.0)
            };
            // Turned to cancel the page's rotation, the object's unrotated
            // bounds are the upright label's width and height swapped.
            let (bounds_width, bounds_height) = if sideways { (11.0, 40.0) } else { (40.0, 11.0) };
            let box_ = page_number_display_box(
                unrotated_width,
                unrotated_height,
                rotation,
                bounds_width,
                bounds_height,
                PageNumberAnchor::BottomCenter,
            );

            // Displayed page is always 600 wide by 800 tall here.
            assert!(
                (box_.left - (300.0 - 20.0)).abs() < 1e-3,
                "rotation {rotation}"
            );
            assert!(
                (box_.top - (800.0 - (BOTTOM_MARGIN + 11.0))).abs() < 1e-3,
                "rotation {rotation}"
            );
            assert!((box_.width - 40.0).abs() < 1e-3, "rotation {rotation}");
        }
    }

    #[test]
    fn clamps_margins_inside_narrow_and_short_pages() {
        let right = page_number_center(100.0, 50.0, 0.0, 40.0, 11.0, PageNumberAnchor::BottomRight);
        let left = page_number_center(100.0, 50.0, 0.0, 40.0, 11.0, PageNumberAnchor::BottomLeft);

        assert!(right.center_x >= 20.0 && right.center_x <= 80.0);
        assert!(left.center_x >= 20.0 && left.center_x <= 80.0);
        assert!(left.center_x <= right.center_x);
        assert!(right.center_y >= 5.5 && right.center_y <= 44.5);
    }

    #[test]
    fn offsets_placement_by_a_cropped_page_origin() {
        let placement = page_number_center_in_box(
            100.0,
            80.0,
            600.0,
            800.0,
            0.0,
            40.0,
            11.0,
            PageNumberAnchor::BottomCenter,
        );

        assert!((placement.center_x - 400.0).abs() < 1e-3);
        assert!((placement.center_y - (80.0 + BOTTOM_MARGIN + 5.5)).abs() < 1e-3);
    }

    #[test]
    fn dark_drops_get_white_ink_and_light_drops_get_black() {
        let black = average_luminance(&[0, 0, 0, 255, 0, 0, 0, 255]);
        let white = average_luminance(&[255, 255, 255, 255, 255, 255, 255, 255]);
        let transparent = average_luminance(&[0, 0, 0, 0, 0, 0, 0, 0]);

        assert!(black < LUMINANCE_THRESHOLD);
        assert!(white >= LUMINANCE_THRESHOLD);
        assert!(transparent >= LUMINANCE_THRESHOLD);
        assert_eq!(ink_color(black), WHITE_INK);
        assert_eq!(ink_color(white), BLACK_INK);
        assert_eq!(ink_color(transparent), BLACK_INK);
        // An empty sample reads as light, so a number stays black.
        assert_eq!(ink_color(average_luminance(&[])), BLACK_INK);
    }

    #[test]
    fn luminance_crosses_at_the_threshold() {
        let dark = relative_luminance(100, 100, 100);
        let light = relative_luminance(160, 160, 160);
        assert!(dark < LUMINANCE_THRESHOLD);
        assert!(light >= LUMINANCE_THRESHOLD);
    }
}
