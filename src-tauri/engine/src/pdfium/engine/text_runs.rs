//! A page's text runs and the text each holds, read in one pass.
//!
//! pdfium-render's segments recount PDFium's rects for each segment they hand
//! out and fetch its text with `FPDFText_GetBoundedText`, which walks every
//! character on the page: on a fragmented page, thousands of passes over
//! thousands of glyphs, 0.9 s for 5,000 single-glyph runs under the documents
//! lock. Here the characters are read once and indexed by position, and each
//! run's text is put together as `CPDF_TextPage::GetTextByRect` does it.
//!
//! The replay follows PDFium chromium/7881. On a PDFium bump, port any change
//! to the functions named below: the parity test
//! `reads_each_text_run_as_pdfium_reads_its_rect` checks one fixture only.

use std::ops::RangeInclusive;

use pdfium_render::prelude::*;

const SPACE: u32 = 0x20;

/// A `CFX_FloatRect` as PDFium hands it out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Bounds {
    pub(super) left: f32,
    pub(super) bottom: f32,
    pub(super) right: f32,
    pub(super) top: f32,
}

impl Bounds {
    /// `CFX_FloatRect::Normalize`, which leaves a NaN side where it is.
    fn normalized(self) -> Self {
        let (left, right) = if self.left > self.right {
            (self.right, self.left)
        } else {
            (self.left, self.right)
        };
        let (bottom, top) = if self.bottom > self.top {
            (self.top, self.bottom)
        } else {
            (self.bottom, self.top)
        };

        Self {
            left,
            bottom,
            right,
            top,
        }
    }

    fn is_finite(self) -> bool {
        [self.left, self.bottom, self.right, self.top]
            .iter()
            .all(|side| side.is_finite())
    }

    /// PDFium's `IsRectIntersect`, called on the rect with the glyph's box.
    /// Its `std::max`/`std::min` keep their first argument against a NaN, so a
    /// NaN side of the glyph's box limits nothing.
    fn overlaps(self, other: Self) -> bool {
        let (a, b) = (self.normalized(), other.normalized());
        let left = if a.left < b.left { b.left } else { a.left };
        let bottom = if a.bottom < b.bottom {
            b.bottom
        } else {
            a.bottom
        };
        let right = if b.right < a.right { b.right } else { a.right };
        let top = if b.top < a.top { b.top } else { a.top };

        !(left >= right || bottom >= top)
    }
}

struct Glyph {
    unicode: u32,
    bounds: Bounds,
    origin_y: f32,
}

/// One of `FPDFText_GetRect`'s rects, with the text
/// `FPDFText_GetBoundedText` gives for it.
pub(super) struct TextRun {
    pub(super) text: String,
    pub(super) bounds: Bounds,
}

pub(super) fn page_runs(
    bindings: &dyn PdfiumLibraryBindings,
    page: &PdfPage,
) -> Result<Vec<TextRun>, String> {
    // SAFETY: the page stays live for this borrow, and the engine serializes
    // PDFium calls.
    let handle = unsafe { bindings.FPDFText_LoadPage(bindings.get_handle_from_page(page)) };

    if handle.is_null() {
        return Err("PDFium could not load the page's text".into());
    }

    let text_page = TextPage { bindings, handle };
    let glyphs = text_page.glyphs();

    Ok(runs(&glyphs, &text_page.rects(glyphs.len())))
}

struct TextPage<'a> {
    bindings: &'a dyn PdfiumLibraryBindings,
    handle: FPDF_TEXTPAGE,
}

impl Drop for TextPage<'_> {
    fn drop(&mut self) {
        // SAFETY: loaded by `page_runs` and closed only here.
        unsafe { self.bindings.FPDFText_ClosePage(self.handle) }
    }
}

impl TextPage<'_> {
    fn glyphs(&self) -> Vec<Glyph> {
        // SAFETY: the handle is live; every index below is under the count, and
        // each out-pointer is a local. PDFium's floats come out widened to
        // doubles, so narrowing them back is exact.
        let count = unsafe { self.bindings.FPDFText_CountChars(self.handle) };

        (0..count)
            .map(|index| unsafe {
                let (mut left, mut right, mut bottom, mut top) = (0.0, 0.0, 0.0, 0.0);
                let (mut x, mut y) = (0.0, 0.0);

                self.bindings.FPDFText_GetCharBox(
                    self.handle,
                    index,
                    &mut left,
                    &mut right,
                    &mut bottom,
                    &mut top,
                );
                self.bindings
                    .FPDFText_GetCharOrigin(self.handle, index, &mut x, &mut y);

                Glyph {
                    unicode: self.bindings.FPDFText_GetUnicode(self.handle, index),
                    bounds: Bounds {
                        left: left as f32,
                        bottom: bottom as f32,
                        right: right as f32,
                        top: top as f32,
                    },
                    origin_y: y as f32,
                }
            })
            .collect()
    }

    /// Counted once: each count rebuilds the rects from every character.
    fn rects(&self, chars: usize) -> Vec<Bounds> {
        // SAFETY: as for `glyphs`; `GetRect` reads the rects this count built.
        let count = unsafe {
            self.bindings
                .FPDFText_CountRects(self.handle, 0, chars as i32)
        };

        (0..count)
            .map(|index| unsafe {
                let (mut left, mut top, mut right, mut bottom) = (0.0, 0.0, 0.0, 0.0);

                self.bindings.FPDFText_GetRect(
                    self.handle,
                    index,
                    &mut left,
                    &mut top,
                    &mut right,
                    &mut bottom,
                );

                Bounds {
                    left: left as f32,
                    bottom: bottom as f32,
                    right: right as f32,
                    top: top as f32,
                }
            })
            .collect()
    }
}

fn runs(glyphs: &[Glyph], rects: &[Bounds]) -> Vec<TextRun> {
    let grid = GlyphGrid::new(glyphs);
    // How many glyphs other than a space precede each glyph: what lay between
    // two matches decides whether a line break joins them.
    let others_before: Vec<usize> = std::iter::once(0)
        .chain(glyphs.iter().scan(0, |count, glyph| {
            *count += usize::from(glyph.unicode != SPACE);
            Some(*count)
        }))
        .collect();
    let mut seen = vec![usize::MAX; glyphs.len()];

    rects
        .iter()
        .enumerate()
        .map(|(stamp, &bounds)| {
            let matches = grid.overlapping(glyphs, bounds, stamp, &mut seen);

            TextRun {
                text: text_of(glyphs, &others_before, &matches),
                bounds,
            }
        })
        .collect()
}

/// `CPDF_TextPage::GetTextByPredicate` over `matches`, the glyphs a rect
/// meets in page order. It walks every glyph, but of those skipped only two
/// things count: a space straight after a match, kept once, even after the
/// last; and any other glyph, which breaks the line if the next match sits on
/// another baseline.
fn text_of(glyphs: &[Glyph], others_before: &[usize], matches: &[usize]) -> String {
    let mut units = Vec::new();
    let mut baseline = 0.0_f32;
    let mut follows_match = false;
    let mut after_other = false;
    let mut next = 0;

    for &index in matches {
        if next < index {
            if follows_match && glyphs[next].unicode == SPACE {
                units.push(SPACE as u16);
            }

            follows_match = false;
            after_other = others_before[index] > others_before[next];
        }

        let glyph = &glyphs[index];

        if (baseline - glyph.origin_y).abs() > 0.0 && !follows_match && after_other {
            baseline = glyph.origin_y;

            if !units.is_empty() {
                units.extend([u16::from(b'\r'), u16::from(b'\n')]);
            }
        }

        follows_match = true;
        after_other = false;

        if glyph.unicode != 0 {
            push_utf16(glyph.unicode, &mut units);
        }

        next = index + 1;
    }

    if follows_match && glyphs.get(next).is_some_and(|glyph| glyph.unicode == SPACE) {
        units.push(SPACE as u16);
    }

    // pdfium-render reads invalid UTF-16 as no text at all. Unlike it, the
    // whole run is decoded: it sized its buffer in wide characters, which cut
    // short, or emptied, a run holding a character beyond the BMP where those
    // are four bytes (Linux, macOS).
    String::from_utf16(&units)
        .map(|text| text.trim_end_matches('\0').to_owned())
        .unwrap_or_default()
}

/// `FX_UTF16Encode`: a supplementary code point as a surrogate pair, any
/// other value as its low 16 bits.
fn push_utf16(value: u32, units: &mut Vec<u16>) {
    match value.checked_sub(0x10000) {
        Some(offset) if offset <= 0xF_FFFF => {
            units.extend([
                0xD800 | (offset >> 10) as u16,
                0xDC00 | (offset & 0x3FF) as u16,
            ]);
        }
        _ => units.push(value as u16),
    }
}

/// Glyph boxes bucketed on a grid over the page, so a rect is tested against
/// the glyphs near it rather than all of them.
struct GlyphGrid {
    extent: Bounds,
    /// Cells per row and per column.
    side: usize,
    cells: Vec<Vec<usize>>,
    /// Boxes with a NaN or infinite side, or too large to bucket, which every
    /// rect tests.
    everywhere: Vec<usize>,
}

const GRID_MAX_SIDE: usize = 64;
const MAX_CELLS_PER_GLYPH: usize = 64;

impl GlyphGrid {
    fn new(glyphs: &[Glyph]) -> Self {
        let boxes: Vec<_> = glyphs
            .iter()
            .map(|glyph| glyph.bounds.normalized())
            .collect();
        let extent = boxes
            .iter()
            .filter(|bounds| bounds.is_finite())
            .fold(None, |extent: Option<Bounds>, &bounds| {
                Some(extent.map_or(bounds, |extent| Bounds {
                    left: extent.left.min(bounds.left),
                    bottom: extent.bottom.min(bounds.bottom),
                    right: extent.right.max(bounds.right),
                    top: extent.top.max(bounds.top),
                }))
            })
            .unwrap_or(Bounds {
                left: 0.0,
                bottom: 0.0,
                right: 0.0,
                top: 0.0,
            });
        let side = (glyphs.len() as f64)
            .sqrt()
            .ceil()
            .clamp(1.0, GRID_MAX_SIDE as f64) as usize;
        let mut grid = Self {
            extent,
            side,
            cells: vec![Vec::new(); side * side],
            everywhere: Vec::new(),
        };

        for (index, &bounds) in boxes.iter().enumerate() {
            match grid.cells_under(bounds) {
                Some((columns, rows))
                    if columns.clone().count() * rows.clone().count() <= MAX_CELLS_PER_GLYPH =>
                {
                    for row in rows {
                        for column in columns.clone() {
                            grid.cells[row * grid.side + column].push(index);
                        }
                    }
                }
                _ => grid.everywhere.push(index),
            }
        }

        grid
    }

    /// The cells a normalized box covers. Cell numbers only grow with the
    /// coordinate, so two boxes that overlap always share a cell.
    fn cells_under(
        &self,
        bounds: Bounds,
    ) -> Option<(RangeInclusive<usize>, RangeInclusive<usize>)> {
        if !bounds.is_finite() {
            return None;
        }

        let cell = |value: f32, start: f32, end: f32, count: usize| {
            let length = end - start;

            if length > 0.0 {
                (((value - start) / length) * count as f32)
                    .floor()
                    .clamp(0.0, (count - 1) as f32) as usize
            } else {
                0
            }
        };
        let column = |x| cell(x, self.extent.left, self.extent.right, self.side);
        let row = |y| cell(y, self.extent.bottom, self.extent.top, self.side);

        Some((
            column(bounds.left)..=column(bounds.right),
            row(bounds.bottom)..=row(bounds.top),
        ))
    }

    /// The glyphs `rect` overlaps, in page order. `seen` holds, per glyph, the
    /// stamp of the last rect that tested it, so a glyph in several cells is
    /// tested once.
    fn overlapping(
        &self,
        glyphs: &[Glyph],
        rect: Bounds,
        stamp: usize,
        seen: &mut [usize],
    ) -> Vec<usize> {
        let mut matches = Vec::new();
        let mut test = |index: usize| {
            if seen[index] != stamp {
                seen[index] = stamp;

                if rect.overlaps(glyphs[index].bounds) {
                    matches.push(index);
                }
            }
        };

        match self.cells_under(rect.normalized()) {
            Some((columns, rows)) => {
                for row in rows {
                    for column in columns.clone() {
                        self.cells[row * self.side + column]
                            .iter()
                            .for_each(|&index| test(index));
                    }
                }

                self.everywhere.iter().for_each(|&index| test(index));
            }
            None => (0..glyphs.len()).for_each(test),
        }

        matches.sort_unstable();
        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(unicode: char, left: f32, bottom: f32, right: f32, top: f32) -> Glyph {
        Glyph {
            unicode: unicode as u32,
            bounds: Bounds {
                left,
                bottom,
                right,
                top,
            },
            origin_y: bottom,
        }
    }

    fn rect(left: f32, bottom: f32, right: f32, top: f32) -> Bounds {
        Bounds {
            left,
            bottom,
            right,
            top,
        }
    }

    fn texts(glyphs: &[Glyph], rects: &[Bounds]) -> Vec<String> {
        runs(glyphs, rects)
            .into_iter()
            .map(|run| run.text)
            .collect()
    }

    #[test]
    fn a_rect_takes_every_glyph_its_box_overlaps_but_not_one_it_touches() {
        let glyphs = [
            glyph('A', 0.0, 0.0, 10.0, 10.0),
            // Overlaps A's box: GetTextByRect takes it into A's run too.
            glyph('B', 9.0, 0.0, 19.0, 10.0),
            // Shares only an edge with B.
            glyph('C', 19.0, 0.0, 29.0, 10.0),
        ];

        assert_eq!(
            texts(&glyphs, &[glyphs[0].bounds, glyphs[2].bounds]),
            ["AB", "C"],
        );
    }

    #[test]
    fn a_skipped_space_joins_matches_once_and_another_glyph_breaks_the_line() {
        let glyphs = [
            glyph('A', 0.0, 0.0, 10.0, 10.0),
            glyph(' ', 100.0, 0.0, 110.0, 10.0),
            glyph(' ', 200.0, 0.0, 210.0, 10.0),
            glyph('B', 20.0, 0.0, 30.0, 10.0),
            // Outside the rect, on the next line down.
            glyph('x', 300.0, -20.0, 310.0, -10.0),
            glyph('C', 0.0, -20.0, 10.0, -10.0),
            // Skipped too, but the match after it shares C's baseline.
            glyph('y', 300.0, -20.0, 310.0, -10.0),
            glyph('D', 20.0, -20.0, 30.0, -10.0),
        ];

        assert_eq!(
            texts(&glyphs, &[rect(0.0, -20.0, 30.0, 10.0)]),
            ["A B\r\nCD"]
        );
    }

    #[test]
    fn a_space_straight_after_the_last_match_is_kept() {
        let glyphs = [
            glyph('A', 0.0, 0.0, 10.0, 10.0),
            glyph(' ', 100.0, 0.0, 110.0, 10.0),
            glyph('B', 200.0, 0.0, 210.0, 10.0),
            glyph(' ', 300.0, 0.0, 310.0, 10.0),
        ];

        assert_eq!(
            texts(&glyphs, &[glyphs[0].bounds, glyphs[2].bounds]),
            ["A ", "B "]
        );
    }

    #[test]
    fn a_glyph_before_the_first_match_breaks_no_line_but_sets_its_baseline() {
        let glyphs = [
            glyph('x', 300.0, 50.0, 310.0, 60.0),
            glyph('A', 0.0, 50.0, 10.0, 60.0),
            glyph('y', 300.0, 50.0, 310.0, 60.0),
            // A's baseline, which the skipped x made the line's rather than 0.
            glyph('B', 20.0, 50.0, 30.0, 60.0),
        ];

        assert_eq!(texts(&glyphs, &[rect(0.0, 50.0, 30.0, 60.0)]), ["AB"]);
    }

    #[test]
    fn a_null_glyph_matches_without_adding_text() {
        let glyphs = [
            glyph('\0', 0.0, 0.0, 10.0, 10.0),
            glyph(' ', 100.0, 0.0, 110.0, 10.0),
            glyph('A', 20.0, 0.0, 30.0, 10.0),
        ];

        assert_eq!(texts(&glyphs, &[rect(0.0, 0.0, 30.0, 10.0)]), [" A"]);
    }

    #[test]
    fn a_supplementary_character_is_kept_whole_and_a_lone_surrogate_empties_the_run() {
        let mut glyphs = vec![
            glyph('A', 0.0, 0.0, 10.0, 10.0),
            glyph('B', 20.0, 0.0, 30.0, 10.0),
        ];
        glyphs[0].unicode = 0x2_0000;
        glyphs[1].unicode = 0xD800;

        assert_eq!(
            texts(&glyphs, &[glyphs[0].bounds, glyphs[1].bounds]),
            ["\u{20000}", ""],
        );
    }

    #[test]
    fn a_nan_side_of_a_glyph_box_limits_nothing() {
        let glyphs = [
            glyph('A', 100.0, 0.0, 110.0, 10.0),
            glyph('B', 500.0, 0.0, 510.0, 10.0),
            // Reaches left without bound, but stops at 200.
            glyph('?', f32::NAN, 0.0, 200.0, 10.0),
        ];

        assert_eq!(
            texts(&glyphs, &[glyphs[0].bounds, glyphs[1].bounds]),
            ["A?", "B"],
        );
    }

    #[test]
    fn the_grid_finds_what_testing_every_glyph_finds() {
        // A fixed pseudo-random page: small glyphs, some spanning many cells,
        // inverted boxes, and rects reaching past the glyphs' extent.
        let mut state = 0x2545_F491_u32;
        let mut next = move |scale: f32| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 10_000) as f32 / 10_000.0 * scale
        };
        let glyphs: Vec<_> = (0..2_000)
            .map(|index| {
                let (x, y) = (next(600.0), next(800.0));
                let size = if index % 97 == 0 {
                    next(400.0)
                } else {
                    next(12.0)
                };
                let (left, right) = if index % 13 == 0 {
                    (x + size, x)
                } else {
                    (x, x + size)
                };

                glyph('a', left, y, right, y + size)
            })
            .collect();
        let rects: Vec<_> = (0..500)
            .map(|_| {
                let (x, y) = (next(700.0) - 50.0, next(900.0) - 50.0);

                rect(x, y, x + next(60.0), y + next(20.0))
            })
            .collect();
        let grid = GlyphGrid::new(&glyphs);
        let mut seen = vec![usize::MAX; glyphs.len()];

        for (stamp, &bounds) in rects.iter().enumerate() {
            let everyone: Vec<_> = (0..glyphs.len())
                .filter(|&index| bounds.overlaps(glyphs[index].bounds))
                .collect();

            assert_eq!(
                grid.overlapping(&glyphs, bounds, stamp, &mut seen),
                everyone
            );
        }
    }
}
