use super::support::*;
use super::*;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_preserves_both_documents_annotations() {
    let engine = test_engine();
    let directory = scratch_directory("merge-annotations");
    let source_path = directory.join("linked.pdf");
    fs::write(&source_path, link_pdf()).expect("the source should write to disk");

    let document = engine
        .open(three_page_link_pdf())
        .expect("PDFium should open the base document");
    engine
        .add_highlight(
            document.id,
            1,
            &[quad(20.0, 60.0, 100.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    engine
        .insert_from_path(document.id, source_path, 4)
        .expect("PDFium should insert the document");

    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        2,
        "the base's link and the session highlight both survive",
    );
    assert_eq!(
        with_page(engine, document.id, 4, |page| page.annotations().len()),
        1,
        "the merged page keeps its own link",
    );

    delete_last_mark(engine, document.id, 1)
        .expect("the session highlight is the session's to remove");
    assert_eq!(
        last_mark(engine, document.id, 1),
        None,
        "the base's own link must stay beyond reach"
    );

    assert_eq!(
        last_mark(engine, document.id, 4),
        None,
        "the merged page's link must stay beyond reach"
    );

    fs::remove_dir_all(directory).ok();
}

// A merged page's bare watermark entry must pin the content it arrived with
// as the base, or the whole-document preflight fails for a page it owns.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_extends_watermark_state() {
    let engine = test_engine();
    let directory = scratch_directory("merge-watermark");
    let source_path = directory.join("added.pdf");
    fs::write(&source_path, banded_pdf(&[100])).expect("the source should write to disk");

    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the base document");
    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    engine
        .insert_from_path(document.id, source_path, 3)
        .expect("PDFium should insert into the watermarked document");

    let objects_on = |page_number: i32| {
        with_page(engine, document.id, page_number, |page| {
            page.objects().len()
        })
    };

    assert_eq!(objects_on(1), 1, "the first page carries its mark");
    assert_eq!(objects_on(2), 1, "the second page carries its mark");
    assert_eq!(
        objects_on(3),
        1,
        "the merged page keeps its own band, unmarked",
    );

    // Removal succeeding proves the bare entry's base was the merged page's
    // content count, not zero — zero fails the preflight for a page holding one.
    engine
        .remove_watermark(document.id)
        .expect("the removal should still pass with the bare merged page");
    assert_eq!(objects_on(1), 0, "the first page is clean");
    assert_eq!(objects_on(2), 0, "the second page is clean");
    assert_eq!(objects_on(3), 1, "the merged page keeps its own band");

    engine
        .apply_watermark(document.id, watermark_config("FINAL"))
        .expect("a fresh watermark should cover every page");
    assert_eq!(objects_on(3), 2, "the merged page gains a mark of its own");

    fs::remove_dir_all(directory).ok();
}

// The frontend undoes a merge by deleting the appended range and redoes it from
// the stash; both must round-trip the merged pages exactly.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_undo_redo_is_lossless() {
    let engine = test_engine();
    let directory = scratch_directory("merge-undo-redo");
    let source_path = directory.join("addendum.pdf");
    fs::write(&source_path, banded_pdf(&[110, 150, 190])).expect("the source should write to disk");

    let document = engine
        .open(banded_pdf(&[20, 60]))
        .expect("PDFium should open the base document");
    engine
        .insert_from_path(document.id, source_path, 3)
        .expect("PDFium should insert the document");
    let merged = page_fingerprints(engine, document.id, 5);

    let update = engine
        .delete_pages(document.id, &[3, 4, 5], 9)
        .expect("the undo should delete the merged range");
    assert_eq!(update.num_pages, 2);

    // Restore comes from the stash, not a re-read of a file that may have
    // changed on disk.
    let update = engine
        .restore_pages(document.id, 9)
        .expect("the redo should restore the merged range from the stash");
    assert_eq!(update.num_pages, 5);
    assert_eq!(
        page_fingerprints(engine, document.id, 5),
        merged,
        "the merged pages should come back byte-for-byte",
    );

    fs::remove_dir_all(directory).ok();
}

// A merged document may not write another file's pages over its source; the
// guard tracks what is present, so undoing the merge lifts it and redo restores it.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_merged_document_will_not_overwrite_its_source() {
    let engine = test_engine();
    let directory = scratch_directory("merge-source-guard");
    let source = directory.join("source.pdf");
    fs::write(&source, banded_pdf(&[30, 70])).expect("the fixture should be writable");
    let original = fs::read(&source).expect("the fixture should be readable");
    let addendum = directory.join("addendum.pdf");
    fs::write(&addendum, banded_pdf(&[110, 150, 190])).expect("the source should write to disk");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the base by path");
    engine
        .insert_from_path(document.id, addendum, 3)
        .expect("PDFium should insert the addendum");

    let error = engine
        .save(document.id)
        .expect_err("a merged document must not save over its source");
    assert!(error.contains("exported as a copy"), "why: {error}");

    let error = engine
        .export_to(document.id, &source)
        .expect_err("a merged export must not land on the source");
    assert_eq!(error, io::EXPORT_COPY_ONLY_ERROR, "why: {error}");
    assert_eq!(
        fs::read(&source).expect("the source should still be readable"),
        original,
        "the refusal has to come before the write, not after it",
    );

    engine
        .export_to(document.id, &directory.join("copy.pdf"))
        .expect("the export should write the merged copy");

    engine
        .delete_pages(document.id, &[3, 4, 5], 1)
        .expect("the undo should delete the merged range");
    engine
        .save(document.id)
        .expect("the un-merged document may save over its source again");

    engine
        .restore_pages(document.id, 1)
        .expect("the redo should restore the merged range");
    engine
        .save(document.id)
        .expect_err("the restored merge forbids saving over the source again");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_invalidates_a_captured_rect_effect() {
    let engine = test_engine();
    let directory = scratch_directory("merge-invalidate");
    let source_path = directory.join("addendum.pdf");
    fs::write(&source_path, banded_pdf(&[110])).expect("the source should write to disk");

    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the base document");
    let revisions = || {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = &documents[&document.id];

        entry
            .page_ids
            .iter()
            .map(|page_id| entry.revisions.get(page_id).copied().unwrap_or(0))
            .collect::<Vec<_>>()
    };

    let captured = revisions();

    engine
        .insert_from_path(document.id, source_path, 3)
        .expect("PDFium should insert the document");

    let after = revisions();

    // Every page that existed before the merge has a new revision, so an M5
    // effect captured before it and processed unlocked is refused on commit.
    assert!(
        captured
            .iter()
            .zip(&after)
            .all(|(before, now)| before != now),
        "a merge should invalidate every existing page",
    );

    fs::remove_dir_all(directory).ok();
}
