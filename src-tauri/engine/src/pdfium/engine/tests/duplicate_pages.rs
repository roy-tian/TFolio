use super::super::page_ops::page_range_argument;
use super::support::*;

#[test]
fn page_range_argument_compresses_runs() {
    assert_eq!(page_range_argument(&[0]), "1");
    assert_eq!(page_range_argument(&[0, 1, 2]), "1-3");
    assert_eq!(page_range_argument(&[0, 2, 4, 5, 6]), "1,3,5-7");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn duplicates_chosen_pages_into_a_gap_of_the_same_document() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20, 60, 110]))
        .expect("PDFium should open the document");
    let before = page_fingerprints(engine, document.id, 3);

    let update = engine
        .duplicate_pages(document.id, &[1, 3], 2)
        .expect("PDFium should copy the pages back in");

    assert_eq!(update.num_pages, 5);
    assert!(
        !update.has_merged_pages,
        "a document's own pages are still its own, so the file stays saveable",
    );
    assert_eq!(
        page_fingerprints(engine, document.id, 5),
        vec![
            before[0].clone(),
            before[0].clone(),
            before[2].clone(),
            before[1].clone(),
            before[2].clone(),
        ],
        "the copies land in the gap and the originals keep their places",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_duplicate_pages_and_positions_that_do_not_exist() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the document");

    let unknown_page = engine
        .duplicate_pages(document.id, &[3], 1)
        .expect_err("the document has two pages");
    assert!(
        unknown_page.contains("does not exist"),
        "why: {unknown_page}"
    );

    let repeated = engine
        .duplicate_pages(document.id, &[2, 2], 1)
        .expect_err("a page cannot be copied twice in one paste");
    assert!(repeated.contains("appears twice"), "why: {repeated}");

    let past_end = engine
        .duplicate_pages(document.id, &[1], 4)
        .expect_err("position 4 is two past the last page");
    assert!(
        past_end.contains("cannot go to position"),
        "why: {past_end}"
    );

    assert_eq!(
        engine
            .documents
            .lock()
            .expect("the document store should be usable")[&document.id]
            .page_ids
            .len(),
        2,
        "every refusal leaves the document as it was",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn duplicating_a_watermarked_page_keeps_the_document_export_only() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the document");

    engine
        .apply_watermark(document.id, watermark_config("ARCHIVE"))
        .expect("PDFium should apply the watermark");

    let update = engine
        .duplicate_pages(document.id, &[1], 3)
        .expect("PDFium should copy the watermarked page");

    assert!(
        update.has_merged_pages,
        "the copy holds a layer this session owns, baked into the page",
    );

    engine
        .remove_watermark(document.id)
        .expect("PDFium should remove the watermark");

    assert!(
        engine
            .duplicate_pages(document.id, &[2], 1)
            .expect("PDFium should copy a page the watermark never covered")
            .has_merged_pages,
        "the baked copy is still there, so the guard stands",
    );
}
