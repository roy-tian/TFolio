use super::super::page_ops::page_range_argument;
use super::support::*;
use super::*;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inserts_a_document_at_the_end() {
    let engine = test_engine();
    let directory = scratch_directory("insert-at-end");
    let source_path = directory.join("addendum.pdf");
    let source_bytes = banded_pdf(&[110, 150, 190]);
    fs::write(&source_path, &source_bytes).expect("the source should write to disk");

    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the base document");
    let before = page_fingerprints(engine, document.id, 2);
    // The source rendered on its own, so the comparison is independent of the
    // merge under test rather than fed back from it.
    let source = engine
        .open(source_bytes)
        .expect("PDFium should open the source on its own");
    let source_prints = page_fingerprints(engine, source.id, 3);

    let outcome = engine
        .insert_from_path(document.id, source_path, 3)
        .expect("PDFium should insert the document");

    assert_eq!(outcome.page_count, 3);
    assert_eq!(outcome.update.num_pages, 5);
    assert!(
        outcome.update.has_merged_pages,
        "another file's pages are present, so the document is export-only",
    );

    let merged = page_fingerprints(engine, document.id, 5);

    assert_eq!(
        &merged[..2],
        &before[..],
        "the base's pages keep their place"
    );
    assert_eq!(
        &merged[2..],
        &source_prints[..],
        "the source's pages land at positions 3-5, in order",
    );

    fs::remove_dir_all(directory).ok();
}

/// One past the end is a position, and so is every gap before it: the source's
/// pages open the gap they were dropped into and push the rest down.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inserts_a_document_between_two_pages() {
    let engine = test_engine();
    let directory = scratch_directory("insert-between");
    let source_path = directory.join("inserted.pdf");
    let source_bytes = banded_pdf(&[110, 150]);
    fs::write(&source_path, &source_bytes).expect("the source should write to disk");

    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the base document");
    let before = page_fingerprints(engine, document.id, 2);
    let source = engine
        .open(source_bytes)
        .expect("PDFium should open the source on its own");
    let source_prints = page_fingerprints(engine, source.id, 2);

    let outcome = engine
        .insert_from_path(document.id, source_path, 2)
        .expect("PDFium should insert the document");

    assert_eq!(outcome.page_count, 2);
    assert_eq!(outcome.update.num_pages, 4);

    let merged = page_fingerprints(engine, document.id, 4);

    assert_eq!(
        merged,
        vec![
            before[0].clone(),
            source_prints[0].clone(),
            source_prints[1].clone(),
            before[1].clone(),
        ],
        "the source opens the gap it was dropped into, in order",
    );

    fs::remove_dir_all(directory).ok();
}

/// The one position check, made in Rust: the WebView names the gap, so a gap
/// the document does not have has to be refused rather than clamped.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_an_insert_past_the_end() {
    let engine = test_engine();
    let directory = scratch_directory("insert-past-end");
    let source_path = directory.join("inserted.pdf");
    fs::write(&source_path, banded_pdf(&[110])).expect("the source should write to disk");

    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the base document");
    let error = engine
        .insert_from_path(document.id, source_path, 4)
        .expect_err("position 4 is two past the last page");

    assert!(error.contains("cannot go to position"), "why: {error}");

    let pages = engine
        .documents
        .lock()
        .expect("the document store should be usable")[&document.id]
        .page_ids
        .len();

    assert_eq!(pages, 2, "the refusal leaves the document as it was");

    fs::remove_dir_all(directory).ok();
}

/// The syntax PDFium's own importer reads, so a scattered selection crosses in
/// one call and in the order the grid shows it.
#[test]
fn page_range_argument_compresses_runs() {
    assert_eq!(page_range_argument(&[0]), "1");
    assert_eq!(page_range_argument(&[0, 1, 2]), "1-3");
    assert_eq!(page_range_argument(&[0, 2, 4, 5, 6]), "1,3,5-7");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn copies_chosen_pages_into_another_document() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the target document");
    let source = engine
        .open(banded_pdf(&[110, 150, 190]))
        .expect("PDFium should open the source document");
    let before = page_fingerprints(engine, document.id, 2);
    let source_prints = page_fingerprints(engine, source.id, 3);

    let update = engine
        .insert_pages_from_document(document.id, source.id, &[1, 3], 2)
        .expect("PDFium should copy the pages across");

    assert_eq!(update.num_pages, 4);
    assert!(
        update.has_merged_pages,
        "another document's pages are present, so this one is export-only",
    );
    assert_eq!(
        page_fingerprints(engine, document.id, 4),
        vec![
            before[0].clone(),
            source_prints[0].clone(),
            source_prints[2].clone(),
            before[1].clone(),
        ],
        "the chosen pages land in the gap, in the order the grid shows them",
    );
    assert_eq!(
        page_fingerprints(engine, source.id, 3),
        source_prints,
        "the document the pages came from keeps them all",
    );
}

/// What the reader sees on the thumbnail is what crosses: a mark this session
/// made on the source travels with the page as the content it has become.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn copied_pages_carry_the_source_marks() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20]))
        .expect("PDFium should open the target document");
    let source = engine
        .open(banded_pdf(&[110]))
        .expect("PDFium should open the source document");

    engine
        .add_rect(
            source.id,
            1,
            &quad(50.0, 60.0, 100.0, 90.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect("PDFium should create the rectangle");

    let marked = page_fingerprints(engine, source.id, 1);

    engine
        .insert_pages_from_document(document.id, source.id, &[1], 2)
        .expect("PDFium should copy the marked page across");

    assert_eq!(
        page_fingerprints(engine, document.id, 2)[1],
        marked[0],
        "the copied page arrives with the mark the reader could see on it",
    );
    // The mark is the source session's; on this side it is input content, with
    // no id of its own and nothing here to take it off again.
    assert_eq!(last_mark(engine, document.id, 2), None);
}

/// Both ends are the WebView's to name, so both are checked here: a page the
/// source does not have, and a gap this document does not have.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_pages_and_positions_that_do_not_exist() {
    let engine = test_engine();
    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the target document");
    let source = engine
        .open(banded_pdf(&[110]))
        .expect("PDFium should open the source document");

    let unknown_page = engine
        .insert_pages_from_document(document.id, source.id, &[2], 1)
        .expect_err("the source has one page");
    assert!(
        unknown_page.contains("does not exist"),
        "why: {unknown_page}"
    );

    let repeated = engine
        .insert_pages_from_document(document.id, source.id, &[1, 1], 1)
        .expect_err("a page cannot cross twice in one drag");
    assert!(repeated.contains("appears twice"), "why: {repeated}");

    let past_end = engine
        .insert_pages_from_document(document.id, source.id, &[1], 4)
        .expect_err("position 4 is two past the last page");
    assert!(
        past_end.contains("cannot go to position"),
        "why: {past_end}"
    );

    // Within one document a drag reorders; taking pages from itself is not a
    // drop the grid can produce, and the two entries could not be borrowed.
    let itself = engine
        .insert_pages_from_document(document.id, document.id, &[1], 1)
        .expect_err("a document cannot take pages from itself");
    assert!(itself.contains("from itself"), "why: {itself}");

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

/// Both the pages and the position are the WebView's to name, so both are
/// checked — and a refusal leaves the document exactly as it stood.
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

/// A copy of a watermarked page carries the watermark as its own content, which
/// no later removal reaches — so the document it lands in may only be exported.
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
