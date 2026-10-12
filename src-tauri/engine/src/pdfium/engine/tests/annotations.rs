use super::support::*;
use super::*;

// A highlight must be drawn, not merely recorded: PDFium keeps an annotation's
// colour in one of two entries and draws a highlight from only one of them.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_highlight_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine.open(text_pdf()).expect("PDFium should open the PDF");
    let band = (90, 80, 310, 140);
    let (inside_before, outside_before) = ink_inside_and_outside(engine, document.id, 1, band);

    engine
        .add_highlight(
            document.id,
            1,
            &[quad(45.0, 40.0, 110.0, 30.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    let (inside_after, outside_after) = ink_inside_and_outside(engine, document.id, 1, band);

    assert!(
        inside_after > inside_before,
        "the highlight put no ink where it was asked for: {inside_before} -> {inside_after}"
    );
    assert_eq!(
        outside_after, outside_before,
        "the highlight put ink outside the run it was asked to cover"
    );

    delete_last_mark(engine, document.id, 1).expect("PDFium should remove the highlight");
    assert_eq!(
        ink_inside_and_outside(engine, document.id, 1, band),
        (inside_before, outside_before),
        "removing the highlight should leave the page as it was"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_square_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let band = (100, 120, 300, 300);
    let (inside_before, outside_before) = ink_inside_and_outside(engine, document.id, 1, band);

    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 60.0, 100.0, 90.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect("PDFium should create the rectangle");

    let (inside_after, outside_after) = ink_inside_and_outside(engine, document.id, 1, band);

    assert!(
        inside_after > inside_before,
        "the rectangle put no ink where it was asked for: {inside_before} -> {inside_after}"
    );
    assert_eq!(
        outside_after, outside_before,
        "the rectangle put ink outside the bounds it was asked to fill"
    );

    delete_last_mark(engine, document.id, 1).expect("PDFium should remove the rectangle");
    assert_eq!(
        ink_inside_and_outside(engine, document.id, 1, band),
        (inside_before, outside_before),
        "removing the rectangle should leave the page as it was"
    );
}

// Only the pixels can say a wash lets the page through — PDFium will accept
// an alpha it then declines to honour.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_translucent_rectangle_lighter_than_a_solid_one() {
    let engine = test_engine();
    let bounds = quad(50.0, 50.0, 100.0, 100.0);

    let solid = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .add_rect(solid.id, 1, &bounds, &rect_style("#000000", 1.0))
        .expect("PDFium should create the solid rectangle");

    let washed = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .add_rect(washed.id, 1, &bounds, &rect_style("#000000", 0.1))
        .expect("PDFium should create the translucent rectangle");

    let solid_darkness = rendered_darkness(engine, solid.id, 1);
    let washed_darkness = rendered_darkness(engine, washed.id, 1);

    assert!(
        washed_darkness > 0,
        "the translucent rectangle drew nothing"
    );
    assert!(
        washed_darkness < solid_darkness / 2,
        "the opacity never reached the fill: {washed_darkness} vs {solid_darkness}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rejects_an_unusable_rectangle() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 10.0, 0.0, 40.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect_err("a rectangle with no area is not a rectangle");
    assert!(error.contains("positive width and height"));

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(f32::NAN, 10.0, 40.0, 40.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect_err("a non-finite coordinate is rejected before it reaches PDFium");
    assert!(error.contains("coordinates are out of range"));

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(3.0e38, 0.0, 3.0e38, 40.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect_err("bounds beyond the page range are rejected");
    assert!(error.contains("coordinates are out of range"));

    // Refused, not clamped: below the floor draws a mark too faint to see that
    // still records as an edit; past full is not a value the reader could choose.
    for style in [
        rect_style("#ff3b30", 0.0),
        rect_style("#ff3b30", 0.09),
        rect_style("#ff3b30", 2.0),
        rect_style("#ff3b30", f32::MAX),
        rect_style("#ff3b30", f32::NAN),
    ] {
        let error = engine
            .add_rect(document.id, 1, &quad(10.0, 10.0, 40.0, 40.0), &style)
            .expect_err("a style value outside its range is rejected");
        assert!(
            error.contains("style values are out of range"),
            "wrong rejection: {error}"
        );
    }

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_style("not-a-colour", 1.0),
        )
        .expect_err("a colour PDFium cannot read is rejected");
    assert!(error.contains("not a usable annotation colour"));

    let error = engine
        .add_rect(
            document.id,
            9,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect_err("a page that does not exist is rejected");
    assert!(error.contains("does not exist"));
}

// A `/Rotate` page is where a wrong axis flip shows. Expected values are
// hardcoded, not read back through the flip that placed the rectangle.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn places_a_rectangle_in_unrotated_space_for_a_rotated_page() {
    let engine = test_engine();
    let document = engine
        .open(rotated_text_pdf())
        .expect("PDFium should open the rotated PDF");

    engine
        .add_rect(
            document.id,
            1,
            &quad(40.0, 30.0, 60.0, 50.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect("PDFium should create the rectangle");

    let bounds = with_page(engine, document.id, 1, |page| {
        page.annotations()
            .get(0)
            .expect("the rectangle should exist")
            .bounds()
            .expect("the rectangle should have bounds")
    });

    assert!(
        (bounds.left().value - 40.0).abs() < 0.5,
        "left was {}, expected 40",
        bounds.left().value
    );
    assert!(
        (bounds.right().value - 100.0).abs() < 0.5,
        "right was {}, expected 100",
        bounds.right().value
    );
    assert!(
        (bounds.top().value - 270.0).abs() < 0.5,
        "top was {}, expected 270",
        bounds.top().value
    );
    assert!(
        (bounds.bottom().value - 220.0).abs() < 0.5,
        "bottom was {}, expected 220",
        bounds.bottom().value
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn writes_a_highlight_that_survives_a_save() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_highlight(
            document.id,
            1,
            &[quad(10.0, 20.0, 80.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    let directory = std::env::temp_dir().join(format!("tfolio-save-{}", document.id));
    fs::create_dir_all(&directory).expect("the test needs a directory to save into");

    let path = directory.join("highlighted.pdf");
    engine
        .save_to(document.id, &path)
        .expect("PDFium should save the document");

    let saved = fs::read(&path).expect("the saved document should be readable");
    let reopened = engine
        .open(saved)
        .expect("PDFium should reopen the saved document");

    assert_eq!(
        with_page(engine, reopened.id, 1, |page| page.annotations().len()),
        1,
        "the highlight should have been written to the file"
    );
    // The fixture page is blank, so any ink is the highlight — which also
    // proves its appearance survived the round trip through the file.
    assert!(
        rendered_darkness(engine, reopened.id, 1) > 0,
        "the reopened highlight put no ink on the page"
    );

    fs::remove_dir_all(&directory).ok();
}

// A rectangle is a Stamp holding a drawn path, a different object from a
// highlight, so surviving the round trip through the file is its own claim.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn writes_a_rectangle_that_survives_a_save() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let band = (100, 120, 300, 300);
    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 60.0, 100.0, 90.0),
            &rect_style("#ff3b30", 1.0),
        )
        .expect("PDFium should create the rectangle");

    let directory = std::env::temp_dir().join(format!("tfolio-save-rect-{}", document.id));
    fs::create_dir_all(&directory).expect("the test needs a directory to save into");

    let path = directory.join("rectangle.pdf");
    engine
        .save_to(document.id, &path)
        .expect("PDFium should save the document");

    let saved = fs::read(&path).expect("the saved document should be readable");
    let reopened = engine
        .open(saved)
        .expect("PDFium should reopen the saved document");

    assert_eq!(
        with_page(engine, reopened.id, 1, |page| page.annotations().len()),
        1,
        "the rectangle should have been written to the file"
    );
    let (inside, outside) = ink_inside_and_outside(engine, reopened.id, 1, band);
    assert!(
        inside > 0,
        "the reopened rectangle put no ink where it was drawn"
    );
    assert_eq!(
        outside, 0,
        "the reopened rectangle put ink outside its bounds"
    );

    fs::remove_dir_all(&directory).ok();
}

// A page's `/Rotate` decides which edge the y-axis flips against, so this is
// where a wrong flip shows up.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn places_a_highlight_in_unrotated_space_for_a_rotated_page() {
    let engine = test_engine();
    let document = engine
        .open(rotated_text_pdf())
        .expect("PDFium should open the rotated PDF");
    let spans = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract text");
    let span = &spans[0];

    engine
        .add_highlight(
            document.id,
            1,
            &[quad(span.left, span.top, span.width, span.height)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    let bounds = with_page(engine, document.id, 1, |page| {
        page.annotations()
            .get(0)
            .expect("the highlight should exist")
            .bounds()
            .expect("the highlight should have bounds")
    });

    // Checked against the page's unrotated height, not `span.top`: a check fed
    // back through the flip would pass with it broken in both directions.
    assert!(
        (bounds.top().value - (300.0 - span.top)).abs() < 0.5,
        "a run {}pt down a 300pt page should sit {}pt up, not {}",
        span.top,
        300.0 - span.top,
        bounds.top().value
    );
    assert!(
        (bounds.left().value - span.left).abs() < 0.5,
        "left was {}, expected {}",
        bounds.left().value,
        span.left
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn deletes_only_the_most_recent_annotation() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    for top in [20.0, 60.0] {
        engine
            .add_highlight(
                document.id,
                1,
                &[quad(10.0, top, 80.0, 12.0)],
                "#ffd54a",
                0.4,
            )
            .expect("PDFium should create the highlight");
    }

    delete_last_mark(engine, document.id, 1).expect("PDFium should remove the annotation");

    let (remaining, bounds) = with_page(engine, document.id, 1, |page| {
        (
            page.annotations().len(),
            page.annotations()
                .get(0)
                .expect("the first highlight should remain")
                .bounds()
                .expect("the highlight should have bounds"),
        )
    });

    assert_eq!(remaining, 1, "only one should have gone");
    // The one left is the one drawn first, so undo took back the later mark.
    assert!(
        (265.0..=282.0).contains(&bounds.top().value),
        "the surviving highlight was at {}",
        bounds.top().value
    );

    delete_last_mark(engine, document.id, 1)
        .expect("PDFium should remove the remaining annotation");

    let error = delete_last_mark(engine, document.id, 1)
        .expect_err("a page with nothing on it has nothing to undo");
    assert!(error.contains("no mark of this session's"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_remove_an_annotation_it_did_not_add() {
    let engine = test_engine();
    let document = engine.open(link_pdf()).expect("PDFium should open the PDF");

    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        1
    );

    assert_eq!(
        last_mark(engine, document.id, 1),
        None,
        "nothing of this session's is on the page yet"
    );

    let mark = engine
        .add_highlight(
            document.id,
            1,
            &[quad(10.0, 20.0, 80.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");
    engine
        .delete_marks(document.id, &[mark])
        .expect("the session's own highlight comes back off");

    // An id names one mark, once. Offered again it must reach nothing — not
    // the document's own annotation now sitting at the end of the page.
    let error = engine
        .delete_marks(document.id, &[mark])
        .expect_err("the document's own annotation is not the session's to remove");
    assert!(error.contains("is not one of this session's"));
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        1,
        "the document's own annotation should still be there"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn finds_the_mark_under_a_point() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 30.0))
            .expect("an empty page answers"),
        None,
        "a page with nothing of this session's on it has nothing to erase"
    );

    let upper = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 20.0, 80.0, 40.0),
            &rect_style("#3b82f6", 0.5),
        )
        .expect("PDFium should draw the rectangle");
    let lower = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 120.0, 80.0, 40.0),
            &rect_style("#3b82f6", 0.5),
        )
        .expect("PDFium should draw the second rectangle");

    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 30.0))
            .expect("the hit test runs"),
        Some(upper),
    );
    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 130.0))
            .expect("the hit test runs"),
        Some(lower),
    );
    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 250.0))
            .expect("the hit test runs"),
        None,
        "a point on neither rectangle is a point on nothing"
    );
    assert!(
        engine
            .mark_at_point(document.id, 1, &note_origin(f32::NAN, 0.0))
            .is_err(),
        "a coordinate off the scale is refused rather than searched"
    );
}

// Two marks over one another: the reader sees the later one, so that is the one
// the point names.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn finds_the_topmost_of_two_marks_over_one_another() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let bounds = quad(10.0, 20.0, 80.0, 40.0);

    engine
        .add_rect(document.id, 1, &bounds, &rect_style("#3b82f6", 0.5))
        .expect("PDFium should draw the rectangle");
    let above = engine
        .add_rect(document.id, 1, &bounds, &rect_style("#ef4444", 0.5))
        .expect("PDFium should draw the second rectangle");

    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 30.0))
            .expect("the hit test runs"),
        Some(above),
    );
}

// A highlight's `/Rect` encloses every run it covers; only the runs themselves
// are drawn, and only they answer a point.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_highlight_answers_for_its_runs_rather_than_the_block_around_them() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let mark = engine
        .add_highlight(
            document.id,
            1,
            &[quad(10.0, 20.0, 30.0, 12.0), quad(120.0, 60.0, 30.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(20.0, 25.0))
            .expect("the hit test runs"),
        Some(mark),
    );
    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(130.0, 65.0))
            .expect("the hit test runs"),
        Some(mark),
    );
    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(130.0, 25.0))
            .expect("the hit test runs"),
        None,
        "the corner of the block the two runs span carries no ink"
    );
}

// The eraser reaches into the middle of a page's owned tail, which is what an
// undo never had to do — and what the ids are for.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn removes_a_mark_from_the_middle_of_the_tail() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let marks = [20.0_f32, 100.0, 180.0]
        .iter()
        .map(|top| {
            engine
                .add_rect(
                    document.id,
                    1,
                    &quad(10.0, *top, 80.0, 40.0),
                    &rect_style("#3b82f6", 0.5),
                )
                .expect("PDFium should draw the rectangle")
        })
        .collect::<Vec<_>>();

    assert_eq!(
        engine
            .delete_marks(document.id, &[marks[1]])
            .expect("the middle mark is the session's to remove"),
        vec![1],
    );
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        2,
        "only the middle one should have gone"
    );

    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 110.0))
            .expect("the hit test runs"),
        None,
    );
    assert_eq!(
        engine
            .mark_at_point(document.id, 1, &note_origin(50.0, 190.0))
            .expect("the hit test runs"),
        Some(marks[2]),
    );
    engine
        .delete_marks(document.id, &[marks[2], marks[0]])
        .expect("both survivors are still the session's to remove");
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        0,
    );
}

// One list, one mark each: an id repeated would delete twice at one position,
// the second time taking whatever slid into it.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_a_removal_that_names_one_mark_twice() {
    let engine = test_engine();
    let document = engine.open(link_pdf()).expect("PDFium should open the PDF");
    let mark = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 20.0, 80.0, 40.0),
            &rect_style("#3b82f6", 0.5),
        )
        .expect("PDFium should draw the rectangle");

    let error = engine
        .delete_marks(document.id, &[mark, mark])
        .expect_err("a mark cannot be removed twice in one step");

    assert!(error.contains("twice"));
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        2,
        "the refusal should leave the page exactly as it was"
    );
}

// A page the reader moved carries its marks with it, so an erase after a
// reorder names the page the mark is on now.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_mark_follows_its_page_through_a_reorder() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");
    let mark = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 20.0, 80.0, 40.0),
            &rect_style("#3b82f6", 0.5),
        )
        .expect("PDFium should draw the rectangle");

    engine
        .reorder_pages(document.id, &[2, 1])
        .expect("PDFium should reorder the pages");

    assert_eq!(
        engine
            .mark_at_point(document.id, 2, &note_origin(50.0, 30.0))
            .expect("the hit test runs"),
        Some(mark),
        "the mark is on page 2 now"
    );
    assert_eq!(
        engine
            .delete_marks(document.id, &[mark])
            .expect("the mark is still the session's to remove"),
        vec![2],
        "and the removal reports where it really was"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rejects_an_unusable_highlight() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    let error = engine
        .add_highlight(document.id, 1, &[], "#ffd54a", 0.4)
        .expect_err("a highlight covering nothing is not a highlight");
    assert!(error.contains("at least one quad"));

    let error = engine
        .add_highlight(
            document.id,
            1,
            &[quad(0.0, 0.0, 10.0, 10.0)],
            "not-a-colour",
            0.4,
        )
        .expect_err("a colour PDFium cannot read is rejected");
    assert!(error.contains("not a usable annotation colour"));

    let error = engine
        .add_highlight(
            document.id,
            1,
            &[quad(0.0, 0.0, 10.0, 10.0)],
            "#ffd54a",
            0.0,
        )
        .expect_err("a fully transparent highlight draws nothing");
    assert!(error.contains("visible colour"));

    let error = engine
        .add_highlight(
            document.id,
            9,
            &[quad(0.0, 0.0, 10.0, 10.0)],
            "#ffd54a",
            0.4,
        )
        .expect_err("a page that does not exist is rejected");
    assert!(error.contains("does not exist"));
}

/// The runs of dark pixels along a horizontal scanline, as `(start, length)`.
fn dark_runs_on_scanline(
    engine: &PdfiumEngine,
    document_id: u64,
    page_number: i32,
    y: u32,
) -> Vec<(u32, u32)> {
    let image = engine
        .render_bitmap(
            document_id,
            page_number,
            TEST_RENDER_WIDTH,
            MAX_RENDER_WIDTH,
        )
        .expect("PDFium should render the page")
        .into_rgb8();
    let mut runs = Vec::new();
    let mut run = 0;

    for x in 0..image.width() {
        let [red, green, blue] = image.get_pixel(x, y).0;

        if (red as u32 + green as u32 + blue as u32) < 600 {
            run += 1;
        } else if run > 0 {
            runs.push((x - run, run));
            run = 0;
        }
    }

    runs
}

// A scanline's dark run tells a full fill from one inset, clipped, or
// spilling past its bounds — counting annotations or total ink would not.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn fills_the_whole_box_it_was_dragged() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 50.0, 100.0, 100.0),
            &rect_style("#000000", 1.0),
        )
        .expect("PDFium should create the rectangle");

    let runs = dark_runs_on_scanline(engine, document.id, 1, 200);

    assert_eq!(
        runs,
        vec![(100, 200)],
        "a block should fill the bounds it was dragged"
    );
}
