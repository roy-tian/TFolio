use super::support::*;
use super::*;

fn changed(engine: &PdfiumEngine, document_id: u64) -> bool {
    engine
        .document_file_changed(document_id)
        .expect("an open document should answer")
}

// Sizes differ at every rewrite below, so no filesystem's timestamp resolution
// can hide one.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn tells_another_writer_from_the_document_itself() {
    let engine = test_engine();
    let directory = scratch_directory("file-changes");
    let source = directory.join("source.pdf");
    fs::write(&source, minimal_pdf()).expect("the fixture should be writable");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the PDF by path");
    assert!(!changed(engine, document.id), "nothing has written it yet");

    fs::write(&source, text_pdf()).expect("the fixture should be rewritable");
    assert!(changed(engine, document.id), "another writer changed it");

    engine.save(document.id).expect("the save should land");
    assert!(
        !changed(engine, document.id),
        "the document's own save is not another writer's"
    );

    let destination = directory.join("renamed.pdf");
    engine
        .export_to(document.id, &destination)
        .expect("the save-as should write the new file");
    fs::write(&source, two_page_pdf()).expect("the old file should be rewritable");
    assert!(
        !changed(engine, document.id),
        "after Save As, the old file is no longer the document's"
    );

    fs::write(&destination, minimal_pdf()).expect("the new file should be rewritable");
    assert!(
        changed(engine, document.id),
        "the new file is watched instead"
    );

    fs::remove_file(&destination).expect("the new file should be removable");
    assert!(
        !changed(engine, document.id),
        "a file gone has nothing newer to offer"
    );

    engine
        .close(document.id)
        .expect("the document should close");
    let _ = fs::remove_dir_all(directory);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watches_a_converted_source_until_save_as_binds_a_pdf() {
    let engine = test_engine();
    let directory = scratch_directory("converted-changes");
    let image_path = directory.join("pixel.png");
    let write_image = |width| {
        image::RgbaImage::from_pixel(width, 30, image::Rgba([12, 120, 200, 255]))
            .save_with_format(&image_path, image::ImageFormat::Png)
            .expect("the test image should save");
    };

    write_image(40);
    let document = engine
        .open_converted("main", image_path.clone())
        .expect("the image should open as its converted PDF");
    assert!(!changed(engine, document.id));

    write_image(80);
    assert!(changed(engine, document.id), "the image was redrawn");

    let destination = directory.join("pixel.pdf");
    engine
        .export_to(document.id, &destination)
        .expect("the save-as should bind the document to a PDF");
    assert!(
        !changed(engine, document.id),
        "bound to its PDF, the document no longer answers for the image"
    );

    write_image(120);
    assert!(!changed(engine, document.id));

    engine
        .close(document.id)
        .expect("the document should close");

    let blank = engine
        .create_blank()
        .expect("PDFium should create a document");
    assert!(!changed(engine, blank.id), "no file, nothing to compare");
    engine.close(blank.id).expect("the document should close");

    let _ = fs::remove_dir_all(directory);
}
