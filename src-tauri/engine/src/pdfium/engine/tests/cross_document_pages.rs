use super::support::*;
use super::*;

fn page_count(engine: &PdfiumEngine, document_id: u64) -> usize {
    engine
        .documents
        .lock()
        .expect("the document store should be usable")[&document_id]
        .page_ids
        .len()
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inserts_another_documents_pages_into_a_gap() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60, 110]))
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[140, 160]))
        .expect("PDFium should open the target");
    let from = page_fingerprints(engine, source.id, 3);
    let into = page_fingerprints(engine, target.id, 2);

    let update = engine
        .insert_pages_from_document(target.id, source.id, &[3, 1], 2)
        .expect("PDFium should copy the pages across");

    assert_eq!(update.num_pages, 4);
    assert!(
        !update.has_merged_pages,
        "plain pages from another file are this document's to save",
    );
    assert_eq!(
        page_fingerprints(engine, target.id, 4),
        vec![
            into[0].clone(),
            from[0].clone(),
            from[2].clone(),
            into[1].clone(),
        ],
        "the copies land in the gap in their own order",
    );
    assert_eq!(
        page_fingerprints(engine, source.id, 3),
        from,
        "the source keeps every page",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_an_insert_from_itself_or_of_pages_and_places_that_do_not_exist() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[140]))
        .expect("PDFium should open the target");

    let itself = engine
        .insert_pages_from_document(target.id, target.id, &[1], 1)
        .expect_err("a document's own pages move by reorder");
    assert!(itself.contains("from itself"), "why: {itself}");

    let unknown_page = engine
        .insert_pages_from_document(target.id, source.id, &[3], 1)
        .expect_err("the source has two pages");
    assert!(
        unknown_page.contains("does not exist"),
        "why: {unknown_page}"
    );

    let past_end = engine
        .insert_pages_from_document(target.id, source.id, &[1], 3)
        .expect_err("position 3 is two past the target's last page");
    assert!(
        past_end.contains("cannot go to position"),
        "why: {past_end}"
    );

    let closed = engine
        .insert_pages_from_document(target.id, u64::MAX, &[1], 1)
        .expect_err("no document has that id");
    assert!(closed.contains("no longer open"), "why: {closed}");

    assert_eq!(
        page_count(engine, target.id),
        1,
        "every refusal leaves it as it was"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_copy_of_another_documents_watermarked_page_keeps_the_target_export_only() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[140]))
        .expect("PDFium should open the target");

    engine
        .apply_watermark(source.id, watermark_config("ARCHIVE"))
        .expect("PDFium should apply the watermark");

    let update = engine
        .insert_pages_from_document(target.id, source.id, &[2], 2)
        .expect("PDFium should copy the watermarked page");

    assert!(
        update.has_merged_pages,
        "the copy holds a layer the source's session owns, baked into the page",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_redo_brings_the_copies_back_after_the_source_has_closed() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[140]))
        .expect("PDFium should open the target");

    engine
        .insert_pages_from_document(target.id, source.id, &[1, 2], 1)
        .expect("PDFium should copy the pages across");

    let inserted = page_fingerprints(engine, target.id, 3);

    // The undo deletes the copied range under the entry's stash.
    engine
        .delete_pages(target.id, &[1, 2], 7)
        .expect("PDFium should take the copies out");
    engine.close(source.id).expect("the source should close");

    let update = engine
        .restore_pages(target.id, 7)
        .expect("the stash, not the closed source, brings them back");

    assert_eq!(update.num_pages, 3);
    assert_eq!(page_fingerprints(engine, target.id, 3), inserted);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn extracts_the_chosen_pages_into_a_new_document() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60, 110]))
        .expect("PDFium should open the source");
    let from = page_fingerprints(engine, source.id, 3);

    let extracted = engine
        .extract_pages(source.id, &[3, 1])
        .expect("PDFium should build the new document");

    assert_ne!(extracted.id(), source.id);
    assert_eq!(extracted.num_pages, 2);
    assert_eq!(extracted.path, None, "a new document has no file yet");
    assert_eq!(
        page_fingerprints(engine, extracted.id(), 2),
        vec![from[0].clone(), from[2].clone()],
        "the pages keep the source's order",
    );
    assert_eq!(
        page_count(engine, source.id),
        3,
        "the source keeps every page"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_extracted_watermarked_page_is_the_new_documents_own_content() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the source");

    engine
        .apply_watermark(source.id, watermark_config("ARCHIVE"))
        .expect("PDFium should apply the watermark");

    let watermarked = page_fingerprints(engine, source.id, 1);
    let extracted = engine
        .extract_pages(source.id, &[1])
        .expect("PDFium should build the new document");
    let documents = engine
        .documents
        .lock()
        .expect("the document store should be usable");
    let entry = &documents[&extracted.id()];

    assert!(
        entry.merged_page_ids.is_empty() && entry.owned_content.is_none(),
        "as an assembled PDF's, the stamp is input content the new file may keep",
    );
    drop(documents);
    assert_eq!(page_fingerprints(engine, extracted.id(), 1), watermarked);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_extract_pages_that_do_not_exist() {
    let engine = test_engine();
    let source = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the source");

    let unknown_page = engine
        .extract_pages(source.id, &[1, 3])
        .expect_err("the source has two pages");
    assert!(
        unknown_page.contains("does not exist"),
        "why: {unknown_page}"
    );

    let none = engine
        .extract_pages(source.id, &[])
        .expect_err("a document needs a page");
    assert!(none.contains("at least one page"), "why: {none}");
}
