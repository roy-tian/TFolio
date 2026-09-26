use super::support::*;
use super::*;

// A hidden temporary left behind is one the reader would never find and never
// clear; saving twice is where one that outlives its save would show up.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn leaves_nothing_beside_a_saved_document() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    let directory = std::env::temp_dir().join(format!("tfolio-save-{}", document.id));
    fs::create_dir_all(&directory).expect("the test needs a directory to save into");

    let path = directory.join("saved.pdf");

    for attempt in 1..=2 {
        engine
            .save_to(document.id, &path)
            .unwrap_or_else(|error| panic!("save {attempt} should have succeeded: {error}"));
    }

    let left: Vec<_> = fs::read_dir(&directory)
        .expect("the destination directory should be readable")
        .map(|entry| entry.expect("the entry should be readable").path())
        .collect();

    assert_eq!(
        left,
        vec![path],
        "a save should leave the document and nothing else"
    );

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn open_by_path_then_save_round_trips() {
    let engine = test_engine();
    let directory = scratch_directory("save-path");
    let path = directory.join("source.pdf");
    fs::write(&path, text_pdf()).expect("the fixture should be writable");

    let document = engine
        .open_from_path(path.clone())
        .expect("PDFium should open the PDF by path");
    assert_eq!(
        document.path.as_deref(),
        path.to_str(),
        "a document opened by path should report that path"
    );

    let band = (90, 80, 310, 140);
    engine
        .add_highlight(
            document.id,
            1,
            &[quad(45.0, 40.0, 110.0, 30.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");
    engine
        .save(document.id)
        .expect("the document should save over its source");

    let left: Vec<_> = fs::read_dir(&directory)
        .expect("the destination directory should be readable")
        .map(|entry| entry.expect("the entry should be readable").path())
        .collect();
    assert_eq!(
        left,
        vec![path.clone()],
        "a save should leave the document and nothing else"
    );

    // Ink, not annotation counts: the reopened file has to *draw* the
    // highlight where it was put, against a clean copy as the baseline.
    let clean = engine
        .open(text_pdf())
        .expect("PDFium should open the clean copy");
    let (clean_inside, clean_outside) = ink_inside_and_outside(engine, clean.id, 1, band);
    let reopened = engine
        .open(fs::read(&path).expect("the saved document should be readable"))
        .expect("PDFium should reopen the saved document");
    let (inside, outside) = ink_inside_and_outside(engine, reopened.id, 1, band);

    assert!(
        inside > clean_inside,
        "the saved highlight should put ink inside its band"
    );
    assert_eq!(
        outside, clean_outside,
        "the saved highlight should change nothing outside its band"
    );

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_save_a_document_opened_from_bytes() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    assert!(document.path.is_none(), "bytes carry no path to report");

    let error = engine
        .save(document.id)
        .expect_err("a document with no source has nothing to save over");
    assert!(
        error.contains("no file to save over"),
        "the refusal should say why: {error}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn export_adopts_the_destination_of_a_byte_opened_document() {
    let engine = test_engine();
    let directory = scratch_directory("adopt");
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let path = directory.join("adopted.pdf");

    let outcome = engine
        .export_to(document.id, &path)
        .expect("the export should write the document");
    assert!(
        outcome.saved_to_source,
        "a byte-opened document's first export is its save-as"
    );

    engine
        .save(document.id)
        .expect("the adopted path should take a save");

    fs::remove_dir_all(&directory).ok();
}

// Save As moves the document to the new file: the next save lands there, and
// the file it was opened from keeps what it held.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn save_as_binds_a_plain_pdf_to_the_new_file() {
    let engine = test_engine();
    let directory = scratch_directory("save-as");
    let source = directory.join("source.pdf");
    fs::write(&source, text_pdf()).expect("the fixture should be writable");
    let original = fs::read(&source).expect("the fixture should be readable");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the PDF by path");

    let destination = directory.join("renamed.pdf");
    let outcome = engine
        .export_to(document.id, &destination)
        .expect("the save-as should write the new file");
    assert!(
        outcome.saved_to_source,
        "a plain PDF's save-as makes the new file its own"
    );
    let saved_as = fs::read(&destination).expect("the new file should be readable");

    engine
        .add_highlight(
            document.id,
            1,
            &[quad(45.0, 40.0, 110.0, 30.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");
    engine
        .save(document.id)
        .expect("the document should save over its new file");

    assert_ne!(
        fs::read(&destination).expect("the new file should be readable"),
        saved_as,
        "the save should land on the save-as destination"
    );
    assert_eq!(
        fs::read(&source).expect("the source should still be readable"),
        original,
        "the file opened first should keep what it held"
    );

    // Exporting onto the bound file is exactly a save, whatever the button was called.
    let onto_source = engine
        .export_to(document.id, &destination)
        .expect("the export should overwrite the bound file");
    assert!(onto_source.saved_to_source);

    fs::remove_dir_all(&directory).ok();
}

// Bound to its copy, a copy-only document would refuse the next write to that
// copy as its own file; it stays on the file `save` already refuses.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_copy_only_export_leaves_the_document_on_its_source() {
    let engine = test_engine();
    let directory = scratch_directory("copy-only-export");

    let watermarked_source = directory.join("watermarked.pdf");
    fs::write(&watermarked_source, minimal_pdf()).expect("the fixture should be writable");
    let watermarked = engine
        .open_from_path(watermarked_source.clone())
        .expect("PDFium should open the PDF by path");
    engine
        .apply_watermark(watermarked.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");

    let merged_source = directory.join("merged.pdf");
    let inserted = directory.join("inserted.pdf");
    fs::write(&merged_source, minimal_pdf()).expect("the fixture should be writable");
    fs::write(&inserted, minimal_pdf()).expect("the fixture should be writable");
    let merged = engine
        .open_from_path(merged_source.clone())
        .expect("PDFium should open the PDF by path");
    engine
        .insert_from_path(merged.id, inserted, 1)
        .expect("PDFium should insert the other file's page");

    for (document_id, source) in [
        (watermarked.id, &watermarked_source),
        (merged.id, &merged_source),
    ] {
        let original = fs::read(source).expect("the source should be readable");
        let copy = directory.join(format!("copy-{document_id}.pdf"));

        for attempt in 1..=2 {
            let outcome = engine
                .export_to(document_id, &copy)
                .unwrap_or_else(|error| panic!("copy {attempt} should be written: {error}"));
            assert!(
                !outcome.saved_to_source,
                "a copy-only document's copy leaves the history unsaved"
            );
        }

        let error = engine
            .export_to(document_id, source)
            .expect_err("the source should still be the file refused");
        assert!(
            error.contains("exported as a copy"),
            "the refusal should say why: {error}"
        );
        assert_eq!(
            fs::read(source).expect("the source should still be readable"),
            original
        );
    }

    fs::remove_dir_all(&directory).ok();
}

// Another document's file is that document's to save: two bound to one file
// would each overwrite the other's edits.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn save_as_refuses_a_file_open_in_another_document() {
    let engine = test_engine();
    let directory = scratch_directory("save-as-open");
    let held = directory.join("held.pdf");
    let other = directory.join("other.pdf");
    fs::write(&held, text_pdf()).expect("the fixture should be writable");
    fs::write(&other, minimal_pdf()).expect("the fixture should be writable");
    let original = fs::read(&held).expect("the fixture should be readable");

    let holder = engine
        .open_from_path(held.clone())
        .expect("PDFium should open the PDF by path");
    let from_path = engine
        .open_from_path(other)
        .expect("PDFium should open the PDF by path");
    let from_bytes = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    fs::create_dir_all(directory.join("sub")).expect("the scratch subdirectory should be made");
    let alias = directory.join("sub").join("..").join("held.pdf");

    for document_id in [from_path.id, from_bytes.id] {
        for destination in [&held, &alias] {
            let error = engine
                .export_to(document_id, destination)
                .expect_err("another document's file must not be written over");
            assert_eq!(
                error,
                io::EXPORT_TARGET_OPEN_ERROR,
                "the refusal should be the code the frontend names"
            );
        }
    }

    assert_eq!(
        fs::read(&held).expect("the held file should still be readable"),
        original,
        "the refusal has to come before the write"
    );

    // Its own document may still write it.
    engine
        .export_to(holder.id, &held)
        .expect("a document's own file takes its save-as");

    fs::remove_dir_all(&directory).ok();
}

// An export onto the source must carry `save`'s watermark refusal, or the
// export dialog becomes the way around it — a closed file can't be unmarked.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_watermarked_export_will_not_overwrite_the_source() {
    let engine = test_engine();
    let directory = scratch_directory("watermark-export");
    let source = directory.join("source.pdf");
    fs::write(&source, minimal_pdf()).expect("the fixture should be writable");
    let original = fs::read(&source).expect("the fixture should be readable");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the PDF by path");
    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");

    let error = engine
        .export_to(document.id, &source)
        .expect_err("a watermarked export must not land on the source");
    assert!(
        error.contains("exported as a copy"),
        "the refusal should say why: {error}"
    );
    assert_eq!(
        fs::read(&source).expect("the source should still be readable"),
        original,
        "the refusal has to come before the write, not after it"
    );

    engine
        .export_to(document.id, &directory.join("copy.pdf"))
        .expect("the export should write the watermarked copy");

    fs::remove_dir_all(&directory).ok();
}

// The dialog hands back whatever spelling the reader navigated to, which on
// a symlinked home or `/tmp` is routinely not the one the source was opened under.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_watermarked_export_resolves_aliases_of_the_source() {
    let engine = test_engine();
    let directory = scratch_directory("watermark-alias");
    let source = directory.join("source.pdf");
    fs::write(&source, minimal_pdf()).expect("the fixture should be writable");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the PDF by path");
    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");

    let alias = directory.join("sub").join("..").join("source.pdf");
    fs::create_dir_all(directory.join("sub")).expect("the scratch subdirectory should be made");

    let error = engine
        .export_to(document.id, &alias)
        .expect_err("an alias of the source is the source");
    assert!(
        error.contains("exported as a copy"),
        "the refusal should say why: {error}"
    );

    fs::remove_dir_all(&directory).ok();
}

// Deleting an annotation strands its resources — a whole font subset for a
// Chinese note — and the save path reloads to collect them; this counts the bytes.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn a_save_after_deletions_collects_what_they_left_behind() {
    let engine = test_engine();

    let clean = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .add_text_note(
            clean.id,
            1,
            &note_origin(20.0, 100.0),
            "你好",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");
    let baseline = saved_size(engine, clean.id);

    // Five undo/redo rounds, each stranding a fresh subset in the document.
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    for _ in 0..=5 {
        engine
            .add_text_note(
                document.id,
                1,
                &note_origin(20.0, 100.0),
                "你好",
                &text_note_style(24.0),
            )
            .expect("PDFium should add the note");
        delete_last_mark(engine, document.id, 1)
            .expect("the session's own note should be removable");
    }
    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "你好",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let collected = saved_size(engine, document.id);
    assert!(
        collected < baseline + 1_500,
        "five undo/redo rounds saved at {collected} bytes against a clean \
             {baseline}; deleted annotations are not being collected"
    );

    // The reload the collection rides on must not surrender the undo guard.
    delete_last_mark(engine, document.id, 1)
        .expect("the session's note should survive the collecting save");
    assert!(
        delete_last_mark(engine, document.id, 1).is_err(),
        "the guard should still refuse the document's own annotations"
    );
}
