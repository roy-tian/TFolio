use super::support::*;
use super::*;

/// The pixel box the ink occupies: unlike `ink_inside_and_outside`, this tells
/// text at its proper size from the same text shrunk or squashed into the band.
fn ink_bounds(
    engine: &PdfiumEngine,
    document_id: u64,
    page_number: i32,
) -> Option<(u32, u32, u32, u32)> {
    let image = engine
        .render_bitmap(
            document_id,
            page_number,
            TEST_RENDER_WIDTH,
            MAX_RENDER_WIDTH,
        )
        .expect("PDFium should render the page")
        .into_rgb8();
    let mut box_of: Option<(u32, u32, u32, u32)> = None;

    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue] = pixel.0;

        // Anything off pure white counts, so a glyph's antialiased edge is
        // part of it rather than a threshold's judgement call.
        if red == 255 && green == 255 && blue == 255 {
            continue;
        }

        box_of = Some(match box_of {
            None => (x, y, x + 1, y + 1),
            Some((left, top, right, bottom)) => {
                (left.min(x), top.min(y), right.max(x + 1), bottom.max(y + 1))
            }
        });
    }

    box_of
}

// The click is the top of the text but PDFium draws from the baseline, so an
// uncorrected note lands a line off — and its own bounds would lie about it.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_note_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "Hello",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    // One line of 24pt type at two pixels per point fits this box around
    // (20,100); a baseline mistaken for the top would put the text above it.
    let band = (36, 194, 360, 254);
    let (inside, outside) = ink_inside_and_outside(engine, document.id, 1, band);

    assert!(
        inside > 0,
        "the note should draw inside the box it was given"
    );
    assert_eq!(
        outside, 0,
        "no part of the note should land outside the line it was placed on"
    );

    // The ink also has to be the *size* a 24pt line is: text scaled into a
    // corner of the right box passes every check above and is still wrong.
    let (left, top, right, bottom) =
        ink_bounds(engine, document.id, 1).expect("the note should draw something");

    // The 20pt left edge is 40px here, give or take the first glyph's side bearing.
    assert!(
        (36..=52).contains(&left),
        "the note started at x={left}px rather than the 40px it was given"
    );
    // Its cap height starts a little below the line's top, never above it.
    assert!(
        (200..=224).contains(&top),
        "the note's first line starts at y={top}px rather than just under 200px"
    );

    let height = bottom - top;
    let width = right - left;

    // Cap height to baseline for 24pt type is around 36px at this scale.
    assert!(
        (24..=60).contains(&height),
        "one line of 24pt type rendered {height}px tall"
    );
    assert!(
        (60..=200).contains(&width),
        "five characters of 24pt type rendered {width}px wide"
    );
}

// A subset stripped of its `cmap` renders every string as the same row of
// boxes — a failure that passes every count-the-annotations check there is.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn draws_the_glyphs_the_text_asked_for() {
    let engine = test_engine();
    let style = text_note_style(24.0);
    let ink_of = |text: &str| {
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the PDF");

        engine
            .add_text_note(document.id, 1, &note_origin(20.0, 100.0), text, &style)
            .expect("PDFium should add the note");
        rendered_darkness(engine, document.id, 1)
    };

    let hello = ink_of("你好");
    let other = ink_of("一二");

    assert!(hello > 0, "a Chinese note should draw something");
    assert_ne!(
        hello, other,
        "different characters should draw differently; identical ink means \
             the embedded subset lost its character map and every note is boxes"
    );
    // The same text twice is the control: ink differs above because the
    // glyphs differ, not because a render is unrepeatable.
    assert_eq!(
        hello,
        ink_of("你好"),
        "the same note should draw the same way"
    );
}

// A Chinese note takes a different route to the page — a subset face, and so
// a different ascent: one PDFium declined to report lands it a line off the click.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn draws_a_chinese_note_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "\u{4f60}\u{597d}",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let (left, top, right, bottom) =
        ink_bounds(engine, document.id, 1).expect("the note should draw something");

    assert!(
        (36..=52).contains(&left),
        "the note started at x={left}px rather than the 40px it was given"
    );
    assert!(
        (200..=224).contains(&top),
        "the note's line starts at y={top}px rather than just under 200px"
    );

    let height = bottom - top;
    let width = right - left;

    // Two full-width characters of 24pt type: about 48px tall and 96 wide.
    assert!(
        (24..=70).contains(&height),
        "one line of 24pt Chinese rendered {height}px tall"
    );
    assert!(
        (60..=200).contains(&width),
        "two characters of 24pt Chinese rendered {width}px wide"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn embeds_only_the_glyphs_a_chinese_note_uses() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let before = saved_size(engine, document.id);

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "你好",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let growth = saved_size(engine, document.id) - before;

    // PDFium embeds whatever bytes it is handed, verbatim — the whole 17 MB
    // face — so this ceiling holds the subsetting to what no unsubset font passes.
    assert!(
        growth < 50_000,
        "a two-character note grew the file by {growth} bytes; the font is \
             not being subset to the note"
    );
}

// The other half of the same contract: text the standard 14 can draw embeds
// nothing at all, which is the common case and should stay free.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn embeds_no_font_for_a_latin_note() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let before = saved_size(engine, document.id);

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "Hello",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let growth = saved_size(engine, document.id) - before;

    // A ceiling between the two outcomes: the tightest subset costs ~3.4 KB
    // against ~650 bytes for a standard font, so one above both passes either way.
    assert!(
        growth < 2_000,
        "a Latin note grew the file by {growth} bytes, so it embedded a font \
             it had no need of"
    );
}

/// The face the embedded chain hands back — the source tree's here, so what is
/// asserted is the branch, not whichever fonts the machine happens to have.
fn resolved_system_face() -> (Vec<u8>, usize) {
    let source = fs::read(crate::pdfium::font::bundled_font_path(
        crate::pdfium::font::CJK_FONT_NAME,
    ))
    .expect("read the face `bun run fonts:download` wrote");

    regular_face(&source, 0).expect("resolve the face the chain would hand back")
}

/// The subset a run should come back as. Both drawable faces are this one file
/// here, so any other bytes mean the machine's own sans answered, not the branch.
fn expected_subset(text: &str) -> Vec<u8> {
    let (bytes, index) = resolved_system_face();

    subset_for(&bytes, index, text).expect("cut the resolved face to the run")
}

// Nothing to fall back to, and the bytes compared exactly: a machine with a
// CJK sans of its own would otherwise cover a broken branch.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn draws_an_embedded_run_in_the_system_face() {
    let engine = font_engine(Some(resolved_system_face()), Vec::new());
    let subset = engine
        .embedded_face_subset("你好")
        .expect("the system's own face should serve the run");

    assert_eq!(
        subset,
        expected_subset("你好"),
        "the run was cut from some other face than the resolved one"
    );
    assert!(
        draws(&subset, "你好"),
        "the subset cut from the system face draws the note as empty boxes"
    );
}

// The other branch: nothing installed can be embedded, but the reader has
// accepted the download at some point, so the fetched face serves the run.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn draws_an_embedded_run_in_the_fetched_face_when_the_system_has_none() {
    let engine = font_engine(
        None,
        vec![crate::pdfium::font::bundled_font_path(
            crate::pdfium::font::CJK_FONT_NAME,
        )],
    );
    let subset = engine
        .embedded_face_subset("你好")
        .expect("the fetched face should serve the run");

    assert_eq!(
        subset,
        expected_subset("你好"),
        "the run was cut from some other face than the fetched one"
    );
    assert!(
        draws(&subset, "你好"),
        "the subset cut from the fetched face draws the note as empty boxes"
    );
}

// Cyrillic with no face configured: both answers are correct depending on the
// machine, so assert one of them — never a subsetting error reaching the frontend.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn asks_the_run_itself_before_offering_the_download() {
    let engine = font_engine(None, Vec::new());

    match engine.embedded_face_subset("Привет") {
        Ok(subset) => assert!(
            draws(&subset, "Привет"),
            "a face accepted for this run should draw it"
        ),
        Err(error) => assert_eq!(
            error, FONT_MISSING_ERROR,
            "the only refusal the frontend can act on is the offer to fetch"
        ),
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn writes_a_chinese_note_that_survives_a_save() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "你好",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let drawn = rendered_darkness(engine, document.id, 1);
    let directory = scratch_directory("note-save");
    let destination = directory.join("note.pdf");

    engine
        .save_to(document.id, &destination)
        .expect("PDFium should save the document");

    let reopened = engine
        .open(fs::read(&destination).expect("the saved document should be readable"))
        .expect("PDFium should reopen the saved document");

    assert_eq!(
        rendered_darkness(engine, reopened.id, 1),
        drawn,
        "a saved note should reopen drawing exactly what it drew before"
    );

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn multiple_lines_stack_down_the_page() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 40.0),
            "One\nTwo",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    // The first line's own band. The second sits a line below it, so ink
    // outside proves the lines were not drawn on top of each other.
    let (first_line, rest) = ink_inside_and_outside(engine, document.id, 1, (0, 0, 400, 140));

    assert!(first_line > 0, "the first line should draw");
    assert!(rest > 0, "the second line should draw below the first");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rejects_an_unusable_note() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let origin = note_origin(20.0, 100.0);
    let style = text_note_style(24.0);

    let cases: Vec<(&str, Result<u64, String>)> = vec![
        (
            "empty text",
            engine.add_text_note(document.id, 1, &origin, "", &style),
        ),
        (
            "whitespace only",
            engine.add_text_note(document.id, 1, &origin, "   \n  ", &style),
        ),
        (
            "a coordinate off the scale",
            engine.add_text_note(document.id, 1, &note_origin(f32::NAN, 0.0), "Hi", &style),
        ),
        (
            "a font size past the control's range",
            engine.add_text_note(document.id, 1, &origin, "Hi", &text_note_style(500.0)),
        ),
        (
            "a font size below the control's range",
            engine.add_text_note(document.id, 1, &origin, "Hi", &text_note_style(1.0)),
        ),
        (
            "an invisible note",
            engine.add_text_note(
                document.id,
                1,
                &origin,
                "Hi",
                &TextNoteStyle {
                    opacity: 0.0,
                    ..text_note_style(24.0)
                },
            ),
        ),
        (
            "an unreadable colour",
            engine.add_text_note(
                document.id,
                1,
                &origin,
                "Hi",
                &TextNoteStyle {
                    color: "not a colour".into(),
                    ..text_note_style(24.0)
                },
            ),
        ),
        (
            "a note longer than the ceiling",
            engine.add_text_note(document.id, 1, &origin, &"a".repeat(5000), &style),
        ),
        (
            "a page that does not exist",
            engine.add_text_note(document.id, 2, &origin, "Hi", &style),
        ),
    ];

    for (case, result) in cases {
        assert!(result.is_err(), "{case} should be refused");
    }

    assert_eq!(
        rendered_darkness(engine, document.id, 1),
        0,
        "a refused note should leave the page as it was"
    );
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        0,
        "a refused note should leave no annotation behind"
    );
}
