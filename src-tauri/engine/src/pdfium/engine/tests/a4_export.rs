use super::support::*;
use super::*;

fn is_a4(page: &PdfPageInfo) -> bool {
    let (short, long) = (page.width.min(page.height), page.width.max(page.height));

    (short - A4_SHORT_POINTS).abs() < 0.5 && (long - A4_LONG_POINTS).abs() < 0.5
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn every_page_lands_on_a4_with_its_bookmarks() {
    let engine = test_engine();
    let document = engine
        .open(outlined_three_page_pdf())
        .expect("PDFium should open the document");
    let mut reports = Vec::new();

    let fitted = engine
        .fit_to_a4(document.id, |done, total| reports.push((done, total)))
        .expect("the pages should fit")
        .expect("nobody stopped it");

    assert_eq!(fitted.num_pages, 3);
    assert!(fitted.pages.iter().all(is_a4));
    assert_eq!(fitted.outline[0].title, "Chapter");
    assert_eq!(fitted.outline[0].page_number, Some(3));
    assert_eq!(reports.last(), Some(&(3, 3)));
    // A copy: the reader's document is as it was.
    assert_eq!(
        engine
            .rotate_pages(document.id, &[1], 0)
            .expect("the document should still answer")
            .pages[0]
            .width,
        200.0
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_large_landscape_page_lies_on_its_side_and_a_small_one_stays_upright() {
    let engine = test_engine();
    let document = engine
        .open(build_pdf(&[
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 700] /Contents 5 0 R >>\nendobj\n"
                .to_string(),
            "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R >>\nendobj\n"
                .to_string(),
            "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ]))
        .expect("PDFium should open the document");

    let fitted = engine
        .fit_to_a4(document.id, |_, _| {})
        .expect("the pages should fit")
        .expect("nobody stopped it");

    assert!(fitted.pages.iter().all(is_a4));
    // Shrunk less on its side; one that fits upright is never turned.
    assert!(fitted.pages[0].width > fitted.pages[0].height);
    assert!(fitted.pages[1].width < fitted.pages[1].height);
}

/// The smallest box around every non-white pixel, as fractions of the render:
/// fractions let an A4 sheet and the page it carries be compared directly.
fn rendered_ink_box(image: &image::RgbImage) -> (f32, f32, f32, f32) {
    let mut left = u32::MAX;
    let mut top = u32::MAX;
    let mut right = 0u32;
    let mut bottom = 0u32;

    for (x, y, pixel) in image.enumerate_pixels() {
        // Only ink well clear of the ground counts, so the box is the mark
        // rather than its anti-aliased halo.
        if pixel.0.iter().all(|channel| *channel > 200) {
            continue;
        }

        left = left.min(x);
        top = top.min(y);
        right = right.max(x + 1);
        bottom = bottom.max(y + 1);
    }

    assert!(left < right && top < bottom, "the page should carry ink");

    let width = image.width() as f32;
    let height = image.height() as f32;

    (
        left as f32 / width,
        top as f32 / height,
        right as f32 / width,
        bottom as f32 / height,
    )
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_rotated_page_lands_on_a4_the_way_it_reads() {
    let engine = test_engine();
    let document = engine
        .open(rotated_text_pdf())
        .expect("PDFium should open the document");
    // `/Rotate 90` makes the page read 300x200, and that is the shape the sheet
    // carries — the rotation cannot survive, since the sheet has one of its own.
    let (left, top, right, bottom) = rendered_ink_box(&rendered_rgb(engine, document.id));

    let fitted = engine
        .fit_to_a4(document.id, |_, _| {})
        .expect("the page should fit")
        .expect("nobody stopped it");
    let sheet = rendered_ink_box(&rendered_rgb(engine, fitted.id));
    let scale_x = 300.0 / A4_SHORT_POINTS;
    let scale_y = 200.0 / A4_LONG_POINTS;
    let margin_x = (1.0 - scale_x) / 2.0;
    let margin_y = (1.0 - scale_y) / 2.0;
    let expected = (
        margin_x + left * scale_x,
        margin_y + top * scale_y,
        margin_x + right * scale_x,
        margin_y + bottom * scale_y,
    );

    for (found, want) in [
        (sheet.0, expected.0),
        (sheet.1, expected.1),
        (sheet.2, expected.2),
        (sheet.3, expected.3),
    ] {
        assert!(
            (found - want).abs() < 0.02,
            "the rotated text should land at {want}, not {found} (whole box {sheet:?})"
        );
    }
}
