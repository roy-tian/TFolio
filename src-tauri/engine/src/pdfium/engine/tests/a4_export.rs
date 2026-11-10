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
