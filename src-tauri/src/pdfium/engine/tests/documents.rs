use super::support::*;
use super::*;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn opens_and_renders_pdf_with_pdfium() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    assert_eq!(document.num_pages, 1);
    assert_eq!(document.pages.len(), 1);

    let png = engine
        .render_page(document.id, 1, 400)
        .expect("PDFium should render the page");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    // The minimal PDF carries no page content, so it has no selectable text.
    let spans = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract text");
    assert!(spans.is_empty());
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn renders_thumbnail_as_webp() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let webp = engine
        .render_thumbnail(document.id, 1, 200)
        .expect("PDFium should render the thumbnail");

    // RIFF container magic, with the four-byte file size in between.
    assert_eq!(&webp[..4], b"RIFF");
    assert_eq!(&webp[8..12], b"WEBP");

    let error = engine
        .render_thumbnail(document.id, 1, MAX_THUMBNAIL_WIDTH + 1)
        .expect_err("thumbnails wider than the cap are rejected");
    assert!(error.contains("render width must be between"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn creates_a_blank_a4_document_with_no_file_of_its_own() {
    let engine = test_engine();
    let document = engine
        .create_blank()
        .expect("PDFium should create a blank document");

    assert_eq!(document.num_pages, 1);

    let page = &document.pages[0];
    assert!(
        (page.width - 595.0).abs() < 1.0 && (page.height - 842.0).abs() < 1.0,
        "the page should be A4, and was {}x{}",
        page.width,
        page.height
    );
    // Nothing to overwrite: the document never came from a file, so the save
    // key stays down until an export gives it one.
    assert!(document.path.is_none());

    engine
        .close(document.id)
        .expect("the new document should close");
}
