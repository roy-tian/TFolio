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

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn export_beside_the_source_is_not_a_save() {
    let engine = test_engine();
    let directory = scratch_directory("beside");
    let source = directory.join("source.pdf");
    fs::write(&source, minimal_pdf()).expect("the fixture should be writable");

    let document = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the PDF by path");

    let copy = engine
        .export_to(document.id, &directory.join("copy.pdf"))
        .expect("the export should write the copy");
    assert!(
        !copy.saved_to_source,
        "a copy elsewhere leaves the source behind the history"
    );

    // Exporting *onto* the source is exactly a save, whatever the button was called.
    let onto_source = engine
        .export_to(document.id, &source)
        .expect("the export should overwrite the source");
    assert!(onto_source.saved_to_source);

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
