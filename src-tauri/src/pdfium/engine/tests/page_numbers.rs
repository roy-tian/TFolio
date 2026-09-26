use super::support::*;
use super::*;

fn page_numbers_config() -> PageNumbersConfig {
    PageNumbersConfig {
        mode: PageNumbersMode::Single,
        position: PageNumbersPosition::BottomCenter,
        range: None,
        start: None,
        // Off by default in the fixtures, so a test asserts a colour only when
        // it means to; `smart_color_flips_on_the_backdrop` turns it on.
        smart_color: false,
        // Likewise: every fixture page is numbered until a test says otherwise,
        // which is also the pair of rules that asks for no render at all.
        blank_numbered: true,
        blank_counted: true,
    }
}

// 600 pt wide, so the side margins pull left- and right-anchored numbers to
// clearly separate halves — a 200 pt page would leave both near the middle.
fn wide_two_page_pdf() -> Vec<u8> {
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 5 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 6 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
    ];

    build_pdf(&objects)
}

// A 600x800 page painted dark across the bottom, where a page number lands,
// and white above it.
fn dark_bottom_pdf() -> Vec<u8> {
    let content = "0.05 g\n0 0 600 130 re f\n";
    let contents = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>\nendobj\n".to_string(),
        contents,
    ];

    build_pdf(&objects)
}

fn extracted_text(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> String {
    engine
        .extract_text(document_id, page_number)
        .expect("PDFium should extract page content")
        .into_iter()
        .map(|span| span.text)
        .collect::<String>()
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn numbers_every_page_and_extracts_the_label() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    let mut progress = Vec::new();
    engine
        .apply_page_numbers_with_progress(document.id, page_numbers_config(), |completed, total| {
            progress.push((completed, total))
        })
        .expect("PDFium should number every page");

    assert_eq!(progress, [(0, 4), (1, 4), (2, 4), (3, 4), (4, 4)]);

    for (page_number, digit) in [(1, "1"), (2, "2")] {
        let (inside, _) =
            ink_inside_and_outside(engine, document.id, page_number, (150, 460, 250, 520));
        assert!(inside > 0, "page {page_number} should render a page number");

        let text = extracted_text(engine, document.id, page_number);
        assert!(
            text.contains('—') && text.contains(digit),
            "page {page_number} should extract as a serif label, got {text:?}"
        );
    }
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn a_stopped_run_leaves_the_document_bare() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    // Stopped from the run's own progress, which puts the flag where the
    // reader's cancel puts it: set while the rebuild holds the document lock.
    let applied = engine
        .apply_page_numbers_with_progress(document.id, page_numbers_config(), |completed, _| {
            if completed > 0 {
                engine.cancel_operation(OperationTarget::Document(document.id));
            }
        })
        .expect("a stopped run is not a failure");

    assert!(!applied, "a stopped run reports that nothing landed");
    assert!(
        !engine.cancel_operation(OperationTarget::Document(document.id)),
        "the operation is off the list once it has returned"
    );

    let band = (150, 460, 250, 520);

    for page_number in [1, 2] {
        let (inside, _) = ink_inside_and_outside(engine, document.id, page_number, band);
        assert_eq!(inside, 0, "page {page_number} should carry no number");
    }

    // The document is not just bare but usable: the reader's next attempt runs
    // against a store that owns nothing, exactly as the first one did.
    assert!(engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number the document on a second attempt"));

    let (inside, _) = ink_inside_and_outside(engine, document.id, 1, band);
    assert!(inside > 0, "the second attempt should number page one");
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn a_stopped_replacement_keeps_the_numbers_it_had() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number every page");

    let mut replacement = page_numbers_config();
    replacement.start = Some(10);

    let applied = engine
        .apply_page_numbers_with_progress(document.id, replacement, |completed, _| {
            if completed > 0 {
                engine.cancel_operation(OperationTarget::Document(document.id));
            }
        })
        .expect("a stopped replacement is not a failure");

    assert!(
        !applied,
        "a stopped replacement reports that nothing landed"
    );

    let text = extracted_text(engine, document.id, 1);
    assert!(
        text.contains('1') && !text.contains("10"),
        "page one should still carry the numbering it had, got {text:?}"
    );
    // The rollback has to put back the tail record as well as the bytes: a
    // remove is refused outright unless the two still describe each other.
    assert!(engine
        .remove_page_numbers(document.id)
        .expect("the numbers it kept are still this session's to remove"));
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn a_replacement_checks_the_owned_tails_first_and_stops_there() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number every page");

    let mut replacement = page_numbers_config();
    replacement.start = Some(10);
    let mut progress = Vec::new();

    engine
        .apply_page_numbers_with_progress(document.id, replacement.clone(), |completed, total| {
            progress.push((completed, total))
        })
        .expect("PDFium should renumber every page");

    // Two pages, checked once and rebuilt in two passes: one run of six.
    assert_eq!(progress.first(), Some(&(0, 6)));
    assert_eq!(progress.last(), Some(&(6, 6)));
    assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));

    // Stopped at once: the check is what it lands in, before any page moves.
    replacement.start = Some(20);
    let applied = engine
        .apply_page_numbers_with_progress(document.id, replacement, |_, _| {
            engine.cancel_operation(OperationTarget::Document(document.id));
        })
        .expect("a stopped check is not a failure");

    assert!(!applied, "a stopped check reports that nothing landed");

    let text = extracted_text(engine, document.id, 1);
    assert!(
        text.contains("10") && !text.contains("20"),
        "page one should keep the numbering it had, got {text:?}"
    );
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn numbers_only_the_selected_range() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    let mut config = page_numbers_config();
    config.range = Some((2, 2));

    engine
        .apply_page_numbers(document.id, config)
        .expect("PDFium should number only the range");

    let band = (150, 460, 250, 520);
    let (first, _) = ink_inside_and_outside(engine, document.id, 1, band);
    let (second, _) = ink_inside_and_outside(engine, document.id, 2, band);

    assert_eq!(first, 0, "page one is outside the range and must stay bare");
    assert!(second > 0, "page two is in the range and must be numbered");
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn custom_start_renumbers_the_range() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    let mut config = page_numbers_config();
    config.range = Some((1, 2));
    config.start = Some(10);

    engine
        .apply_page_numbers(document.id, config)
        .expect("PDFium should renumber from the custom start");

    assert!(
        extracted_text(engine, document.id, 1).contains("10"),
        "the range's first page prints the start"
    );
    assert!(
        extracted_text(engine, document.id, 2).contains("11"),
        "the next page counts up from it"
    );
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn duplex_mirrors_odd_and_even_pages() {
    let engine = test_engine();
    let document = engine
        .open(wide_two_page_pdf())
        .expect("PDFium should open the wide fixture");
    let mut config = page_numbers_config();
    config.mode = PageNumbersMode::Duplex;

    engine
        .apply_page_numbers(document.id, config)
        .expect("PDFium should number both sides");

    let left_band = (10, 470, 110, 515);
    let right_band = (300, 470, 390, 515);
    let (odd_left, _) = ink_inside_and_outside(engine, document.id, 1, left_band);
    let (odd_right, _) = ink_inside_and_outside(engine, document.id, 1, right_band);
    let (even_left, _) = ink_inside_and_outside(engine, document.id, 2, left_band);
    let (even_right, _) = ink_inside_and_outside(engine, document.id, 2, right_band);

    assert!(
        odd_right > 0 && odd_left == 0,
        "an odd page binds bottom-right"
    );
    assert!(
        even_left > 0 && even_right == 0,
        "an even page binds bottom-left"
    );
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn smart_colour_flips_on_the_backdrop() {
    let engine = test_engine();
    let mut config = page_numbers_config();
    config.smart_color = true;

    // A dark drop takes white ink, so the label's band holds bright pixels the
    // dark background could not have.
    let dark = engine
        .open(dark_bottom_pdf())
        .expect("PDFium should open the dark fixture");
    engine
        .apply_page_numbers(dark.id, config.clone())
        .expect("PDFium should number the dark page");
    let image = engine
        .render_bitmap(dark.id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
        .expect("PDFium should render the dark page")
        .into_rgb8();
    // The fill is near-black (~13), so any pixel well above it in the band is
    // white ink — thin strokes anti-alias below full white at this resolution.
    let bright = (150..250)
        .flat_map(|x| (470..515).map(move |y| (x, y)))
        .filter(|&(x, y)| image.get_pixel(x, y).0.iter().all(|channel| *channel > 90))
        .count();
    assert!(bright > 0, "a dark drop should take white ink");

    // A light drop takes black ink: the band holds dark pixels a white page
    // could not have.
    let light = engine
        .open(wide_two_page_pdf())
        .expect("PDFium should open the light fixture");
    engine
        .apply_page_numbers(light.id, config)
        .expect("PDFium should number the light page");
    let image = engine
        .render_bitmap(light.id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
        .expect("PDFium should render the light page")
        .into_rgb8();
    // The page is otherwise white, so any pixel well below it in the band is
    // black ink — thin strokes anti-alias above full black at this resolution.
    let dark_pixels = (150..250)
        .flat_map(|x| (470..515).map(move |y| (x, y)))
        .filter(|&(x, y)| image.get_pixel(x, y).0.iter().all(|channel| *channel < 160))
        .count();
    assert!(dark_pixels > 0, "a light drop should take black ink");
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn places_numbers_in_display_space_on_rotated_pages() {
    let engine = test_engine();

    for rotation in [0, 90, 180, 270] {
        let document = engine
            .open(rotated_blank_pdf(rotation))
            .expect("PDFium should open the rotated fixture");

        engine
            .apply_page_numbers(document.id, page_numbers_config())
            .expect("PDFium should number the rotated page");

        let image = engine
            .render_bitmap(document.id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
            .expect("PDFium should render the rotated page")
            .into_rgb8();
        let (width, height) = (image.width() as f32, image.height() as f32);
        let mut inside = 0u64;
        let mut outside = 0u64;

        // Whichever way the page is turned, the number sits at the bottom
        // centre of what the reader sees — the rendered image.
        for (x, y, pixel) in image.enumerate_pixels() {
            let ink = pixel
                .0
                .iter()
                .map(|channel| (255 - *channel) as u64)
                .sum::<u64>();
            let centred = (x as f32) > width * 0.3 && (x as f32) < width * 0.7;
            let low = (y as f32) > height * 0.6 && (y as f32) < height * 0.95;

            if centred && low {
                inside += ink;
            } else {
                outside += ink;
            }
        }

        assert!(
            inside > 0,
            "rotation {rotation} should place a number at the display bottom centre"
        );
        assert_eq!(
            outside, 0,
            "rotation {rotation} should leave the rest of the page bare"
        );
    }
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn replacing_page_numbers_does_not_stack() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number the pages");
    let mut moved = page_numbers_config();
    moved.position = PageNumbersPosition::BottomRight;
    engine
        .apply_page_numbers(document.id, moved)
        .expect("PDFium should move the numbers");

    for page_number in 1..=2 {
        assert_eq!(
            with_page(engine, document.id, page_number, |page| page
                .objects()
                .len()),
            1,
            "page {page_number} should carry exactly one page-number object"
        );
    }
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn removing_page_numbers_restores_the_page() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    let before = engine
        .render_page(document.id, 1, 400)
        .expect("PDFium should render the plain page");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number the page");
    engine
        .remove_page_numbers(document.id)
        .expect("PDFium should lift its own page numbers");

    assert_eq!(
        engine
            .render_page(document.id, 1, 400)
            .expect("PDFium should render the restored page"),
        before,
        "removing the page numbers should restore the original page"
    );
    for page_number in 1..=2 {
        assert_eq!(
            with_page(engine, document.id, page_number, |page| page
                .objects()
                .len()),
            0,
            "page {page_number} should be clean again"
        );
    }
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn coexists_with_a_watermark() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number over the watermark");

    let text = extracted_text(engine, document.id, 1);
    assert!(
        text.contains("DRAFT") && text.contains('—'),
        "both layers should be present, got {text:?}"
    );

    engine
        .remove_page_numbers(document.id)
        .expect("removing page numbers should keep the watermark");
    let text = extracted_text(engine, document.id, 1);
    assert!(
        text.contains("DRAFT") && !text.contains('—'),
        "the watermark should survive, the numbers should not: {text:?}"
    );

    engine
        .remove_watermark(document.id)
        .expect("removing the watermark should now clear the page");
    assert!(
        !extracted_text(engine, document.id, 1).contains("DRAFT"),
        "the watermark should be gone too"
    );
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn refuses_a_foreign_page_number_tail() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number the pages");
    let first_page_objects = with_page(engine, document.id, 1, |page| page.objects().len());

    // Another editor appends content after this session's tail on page two.
    {
        let mut documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = documents
            .get_mut(&document.id)
            .expect("the fixture should still be open");
        let mut page = entry
            .document
            .pages_mut()
            .get(1)
            .expect("the fixture should have a second page");
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
        page.objects_mut()
            .create_path_object_rect(
                PdfRect::new_from_values(10.0, 10.0, 20.0, 20.0),
                None,
                None,
                Some(PdfColor::BLACK),
            )
            .expect("PDFium should append foreign page content");
        page.regenerate_content()
            .expect("PDFium should regenerate the corrupted fixture");
        page.set_content_regeneration_strategy(
            PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
        );
    }

    let error = engine
        .remove_page_numbers(document.id)
        .expect_err("foreign page content must invalidate the ownership guard");

    assert!(error.contains("no longer ends"));
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.objects().len()),
        first_page_objects,
        "whole-document preflight must fail before page one is changed"
    );
}

// A grey just above the luminance split where the number lands: close enough
// that resampling over the label's own previous ink would tip it under to white.
fn grey_band_pdf() -> Vec<u8> {
    let content = "0.53 g\n0 0 600 130 re f\n";
    let contents = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>\nendobj\n".to_string(),
        contents,
    ];

    build_pdf(&objects)
}

#[test]
#[ignore = "requires `bun run fonts:download`"]
fn smart_colour_resamples_the_backdrop_not_its_own_label() {
    let engine = test_engine();
    let document = engine
        .open(grey_band_pdf())
        .expect("PDFium should open the grey-band fixture");
    let mut config = page_numbers_config();
    config.smart_color = true;

    let band = |image: &image::RgbImage| {
        let mut dark = 0u32;
        let mut bright = 0u32;

        for x in 150..250 {
            for y in 470..515 {
                let pixel = image.get_pixel(x, y).0;
                if pixel.iter().all(|channel| *channel < 90) {
                    dark += 1;
                }
                if pixel.iter().all(|channel| *channel > 200) {
                    bright += 1;
                }
            }
        }

        (dark, bright)
    };

    engine
        .apply_page_numbers(document.id, config)
        .expect("PDFium should number the grey page");
    let (dark, bright) = band(
        &engine
            .render_bitmap(document.id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
            .expect("PDFium should render the numbered page")
            .into_rgb8(),
    );
    assert!(dark > 0, "a light-grey drop should take black ink");
    assert_eq!(bright, 0, "and not white");

    // A watermark rebuild resamples the drop: the previous label must be popped
    // first, or the black it is replacing tips the average under the split.
    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should watermark the numbered page");
    let (dark, bright) = band(
        &engine
            .render_bitmap(document.id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
            .expect("PDFium should render the resampled page")
            .into_rgb8(),
    );
    assert!(
        dark > 0,
        "the number must stay black after a resampling rebuild"
    );
    assert_eq!(bright, 0, "and never flip to white on its own ink");
}

/// Three pages where the middle one prints nothing the eye can see and the
/// others carry a black band clear of the strip a page number sits in.
fn blank_middle_page_pdf() -> Vec<u8> {
    let mut objects = vec![
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n".to_string(),
    ];

    for page in 0..3 {
        objects.push(format!(
            "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents {} 0 R >>\nendobj\n",
            3 + page,
            6 + page,
        ));
    }

    for page in 0..3 {
        // The empty page draws white rather than nothing, so it owns an object
        // and the blank test must render to find out — the path under test.
        let content = if page == 1 {
            "1 1 1 rg\n40 150 120 100 re f\n".to_string()
        } else {
            "0 0 0 rg\n40 150 120 100 re f\n".to_string()
        };

        objects.push(format!(
            "{} 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            6 + page,
            content.len(),
        ));
    }

    build_pdf(&objects)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn blank_pages_can_leave_the_numbering_or_only_its_ink() {
    let engine = test_engine();
    let document = engine
        .open(blank_middle_page_pdf())
        .expect("PDFium should open the blank-middle fixture");

    let mut silent = page_numbers_config();
    silent.blank_numbered = false;

    engine
        .apply_page_numbers(document.id, silent)
        .expect("PDFium should number around the blank page");

    assert!(extracted_text(engine, document.id, 1).contains('1'));
    assert!(
        !extracted_text(engine, document.id, 2).contains('—'),
        "an unnumbered blank page should carry no label"
    );
    assert!(extracted_text(engine, document.id, 3).contains('3'));

    // Neither counted nor numbered: numbering closes up over it. The re-run
    // re-reads pages the first apply labelled and must not mistake that for content.
    let mut skipped = page_numbers_config();
    skipped.blank_numbered = false;
    skipped.blank_counted = false;

    engine
        .apply_page_numbers(document.id, skipped)
        .expect("PDFium should renumber without the blank page");

    assert!(extracted_text(engine, document.id, 1).contains('1'));
    assert!(!extracted_text(engine, document.id, 2).contains('—'));
    assert!(
        extracted_text(engine, document.id, 3).contains('2'),
        "the page after a skipped blank should take its number"
    );
}

/// Annotations are no part of a page's object count, but they are drawn — a
/// page the reader has written on is a page with something on it.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_page_carrying_only_an_annotation_is_not_blank() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .add_text_note(
            document.id,
            2,
            &note_origin(20.0, 100.0),
            "note",
            &text_note_style(24.0),
        )
        .expect("PDFium should add the note");

    let mut skipped = page_numbers_config();
    skipped.blank_numbered = false;
    skipped.blank_counted = false;

    engine
        .apply_page_numbers(document.id, skipped)
        .expect("PDFium should number the document");

    assert!(
        !extracted_text(engine, document.id, 1).contains('—'),
        "the page with nothing on it takes no number"
    );
    assert!(
        extracted_text(engine, document.id, 2).contains('1'),
        "the page with a note on it takes the first one"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_page_stays_blank_under_a_number_this_session_drew() {
    let engine = test_engine();
    let document = engine
        .open(blank_middle_page_pdf())
        .expect("PDFium should open the blank-middle fixture");

    engine
        .apply_page_numbers(document.id, page_numbers_config())
        .expect("PDFium should number every page");
    assert!(extracted_text(engine, document.id, 2).contains('—'));

    let mut skipped = page_numbers_config();
    skipped.blank_numbered = false;
    skipped.blank_counted = false;

    engine
        .apply_page_numbers(document.id, skipped)
        .expect("PDFium should renumber the document");

    // The blank test reads the page above its own number's band, so the label
    // the first apply drew there cannot make the page look printed-on.
    assert!(!extracted_text(engine, document.id, 2).contains('—'));
    assert!(extracted_text(engine, document.id, 3).contains('2'));
}
