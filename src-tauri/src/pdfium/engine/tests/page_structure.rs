use super::super::page_ops::{validate_page_order, validate_pages_to_delete};
use super::support::*;
use super::*;

// Four pages, each with one black bar at a page-specific horizontal position,
// so every page renders to a distinct pixel fingerprint.
fn four_page_banded_pdf() -> Vec<u8> {
    let mut objects = vec![
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>\nendobj\n"
            .to_string(),
    ];

    for page in 0..4 {
        objects.push(format!(
            "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents {} 0 R >>\nendobj\n",
            3 + page,
            7 + page,
        ));
    }

    for page in 0..4 {
        let content = format!("0 0 0 rg\n{} 100 30 120 re f\n", 20 + page * 40);

        objects.push(format!(
            "{} 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            7 + page,
            content.len(),
        ));
    }

    build_pdf(&objects)
}

// Two pages where only the second carries heavy content, so deleting it leaves
// a measurable hole for compaction to reclaim.
fn heavy_second_page_pdf() -> Vec<u8> {
    let mut content = "0 0 0 rg\n".to_string();

    for left in (0..595).step_by(2) {
        content.push_str(&format!("{left} 0 1 842 re f\n"));
    }

    let contents_obj = format!(
        "6 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );

    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        contents_obj,
    ])
}

// A 200x300 page and a 400x500 page, so an inserted blank's size names the
// neighbour it was measured from.
fn two_size_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents 5 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
    ])
}

#[test]
fn page_order_validation_refuses_everything_but_a_permutation() {
    assert_eq!(validate_page_order(&[1, 2, 3], 3), Ok(None));
    // A genuine permutation comes back as zero-based move indices.
    assert_eq!(validate_page_order(&[3, 1, 2], 3), Ok(Some(vec![2, 0, 1])));

    for (case, order) in [
        ("too short", &[1, 2][..]),
        ("too long", &[1, 2, 3, 4][..]),
        ("a repeat", &[1, 2, 2][..]),
        ("out of range", &[1, 2, 4][..]),
        ("below range", &[0, 1, 2][..]),
        ("an overflowing number", &[i32::MIN, 1, 2][..]),
    ] {
        assert!(
            validate_page_order(order, 3).is_err(),
            "{case} should be refused",
        );
    }
}

#[test]
fn deletion_validation_keeps_a_page_and_refuses_junk() {
    // Selections come back as ascending zero-based indices however given.
    assert_eq!(validate_pages_to_delete(&[3, 1], 4), Ok(vec![0, 2]));

    for (case, pages) in [
        ("an empty selection", &[][..]),
        ("a repeat", &[2, 2][..]),
        ("out of range", &[5][..]),
        ("below range", &[0][..]),
        ("every page", &[1, 2, 3, 4][..]),
        ("an overflowing number", &[i32::MIN][..]),
    ] {
        assert!(
            validate_pages_to_delete(pages, 4).is_err(),
            "{case} should be refused",
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reorders_pages_and_their_content() {
    let engine = test_engine();
    let document = engine
        .open(four_page_banded_pdf())
        .expect("PDFium should open the banded PDF");
    let before = page_fingerprints(engine, document.id, 4);

    for (index, fingerprint) in before.iter().enumerate() {
        for other in &before[index + 1..] {
            assert_ne!(fingerprint, other, "the fixture pages should be distinct");
        }
    }

    let order = [3, 1, 4, 2];
    let update = engine
        .reorder_pages(document.id, &order)
        .expect("PDFium should reorder the pages");

    assert_eq!(update.num_pages, 4, "a reorder keeps every page");

    let after = page_fingerprints(engine, document.id, 4);

    for (position, old_number) in order.iter().enumerate() {
        assert_eq!(
            after[position],
            before[(old_number - 1) as usize],
            "position {} should hold the old page {old_number}",
            position + 1,
        );
    }
}

// Three pages no two of which measure alike, the middle rotated: a wrong or
// stale page list cannot pass for the right one.
fn three_size_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Rotate 90 /Contents 6 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Contents 6 0 R >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
    ])
}

fn reported_geometry(update: &PdfStructureUpdate) -> Vec<(f32, f32, f32)> {
    update
        .pages
        .iter()
        .map(|page| (page.width, page.height, page.rotation))
        .collect()
}

// Measuring a page out of PDFium costs a page load, so the engine memoises
// each page's geometry under its stable id — this says the memo follows the pages.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reported_page_geometry_follows_the_pages_through_every_structure_edit() {
    let engine = test_engine();
    let document = engine
        .open(three_size_pdf())
        .expect("PDFium should open the three-size PDF");
    let original = vec![
        (200.0, 300.0, 0.0),
        // Displayed through its own /Rotate 90, so its sides are swapped.
        (500.0, 400.0, 90.0),
        (600.0, 700.0, 0.0),
    ];

    assert_eq!(
        document
            .pages
            .iter()
            .map(|page| (page.width, page.height, page.rotation))
            .collect::<Vec<_>>(),
        original,
    );

    let reordered = engine
        .reorder_pages(document.id, &[3, 1, 2])
        .expect("PDFium should reorder the pages");

    assert_eq!(
        reported_geometry(&reordered),
        vec![original[2], original[0], original[1]],
        "each page's size should travel to its new position",
    );

    let deleted = engine
        .delete_pages(document.id, &[1], 1)
        .expect("PDFium should delete the page");

    assert_eq!(
        reported_geometry(&deleted),
        vec![original[0], original[1]],
        "the deleted page's size should go with it",
    );

    let inserted = engine
        .insert_blank_page(document.id, 1)
        .expect("PDFium should insert a blank page");

    assert_eq!(
        reported_geometry(&inserted),
        vec![original[0], original[0], original[1]],
        "a page new to the document should be measured, not guessed",
    );

    let restored = engine
        .restore_pages(document.id, 1)
        .expect("PDFium should restore the stashed page");

    assert_eq!(
        reported_geometry(&restored),
        vec![original[2], original[0], original[0], original[1]],
        "a page out of the stash should come back with its own size",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn turns_the_named_pages_and_reports_their_new_shape() {
    let engine = test_engine();
    let document = engine
        .open(three_size_pdf())
        .expect("PDFium should open the three-size PDF");
    let original = vec![
        (200.0, 300.0, 0.0),
        // Displayed through its own /Rotate 90, so its sides are swapped.
        (500.0, 400.0, 90.0),
        (600.0, 700.0, 0.0),
    ];
    let turned = engine
        .rotate_pages(document.id, &[1, 2], 90)
        .expect("PDFium should turn the pages");

    assert_eq!(
        reported_geometry(&turned),
        vec![
            // A quarter turn on top of what each page already carried, and the
            // memo that would have answered with the old shape retired for it.
            (300.0, 200.0, 90.0),
            (400.0, 500.0, 180.0),
            original[2],
        ],
    );

    let back = engine
        .rotate_pages(document.id, &[1, 2], 270)
        .expect("PDFium should turn the pages the rest of the way");

    assert_eq!(
        reported_geometry(&back),
        original,
        "the rest of the circle is what an undo turns, whatever each page started at",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_turned_page_renders_turned_and_reopens_turned() {
    let engine = test_engine();
    let document = engine
        .open(four_page_banded_pdf())
        .expect("PDFium should open the banded PDF");
    let upright = page_fingerprints(engine, document.id, 4);

    engine
        .rotate_pages(document.id, &[2], 180)
        .expect("PDFium should turn the page");

    let turned = page_fingerprints(engine, document.id, 4);

    assert_ne!(
        turned[1], upright[1],
        "the turned page should render turned"
    );
    assert_eq!(
        (turned[0].clone(), turned[2].clone(), turned[3].clone()),
        (upright[0].clone(), upright[2].clone(), upright[3].clone()),
        "no other page should have moved",
    );

    let directory = scratch_directory("rotate-save");
    let destination = directory.join("turned.pdf");

    engine
        .save_to(document.id, &destination)
        .expect("the turn should reach the file");

    let reopened = engine
        .open(fs::read(&destination).expect("the saved file should be readable"))
        .expect("PDFium should reopen the saved file");

    assert_eq!(
        reopened
            .pages
            .iter()
            .map(|page| page.rotation)
            .collect::<Vec<_>>(),
        vec![0.0, 180.0, 0.0, 0.0],
        "the turn is the document's own now, not the session's",
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_a_turn_it_cannot_make() {
    let engine = test_engine();
    let document = engine
        .open(four_page_banded_pdf())
        .expect("PDFium should open the banded PDF");
    let before = page_fingerprints(engine, document.id, 4);

    for (case, pages, degrees) in [
        ("a page the document does not have", vec![5], 90),
        ("a page named twice", vec![2, 2], 90),
        ("no page at all", vec![], 90),
        ("a turn that is not a quarter", vec![1], 45),
    ] {
        assert!(
            engine.rotate_pages(document.id, &pages, degrees).is_err(),
            "{case} should be refused",
        );
    }

    assert_eq!(
        page_fingerprints(engine, document.id, 4),
        before,
        "a refused turn should leave every page as it was",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_whole_circle_turns_nothing_and_invalidates_nothing() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");
    let revision = || {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = &documents[&document.id];

        entry
            .revisions
            .get(&entry.page_ids[0])
            .copied()
            .unwrap_or(0)
    };
    let captured = revision();
    let update = engine
        .rotate_pages(document.id, &[1], 360)
        .expect("a full circle is accepted");

    assert_eq!(update.num_pages, 2);
    assert_eq!(
        revision(),
        captured,
        "a turn that comes to nothing should invalidate nothing",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reorder_is_a_no_op_for_the_identity_order() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");
    let revision = || {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = &documents[&document.id];

        entry
            .revisions
            .get(&entry.page_ids[0])
            .copied()
            .unwrap_or(0)
    };
    let captured = revision();
    let update = engine
        .reorder_pages(document.id, &[1, 2])
        .expect("the identity order is accepted");

    assert_eq!(update.num_pages, 2);
    assert_eq!(
        revision(),
        captured,
        "an order that moves nothing should invalidate nothing",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reorder_keeps_annotations_with_their_page() {
    let engine = test_engine();
    let document = engine
        .open(three_page_link_pdf())
        .expect("PDFium should open the link PDF");

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
        .reorder_pages(document.id, &[2, 3, 1])
        .expect("PDFium should reorder the pages");

    for page_number in [1, 2] {
        assert_eq!(
            with_page(engine, document.id, page_number, |page| page
                .annotations()
                .len()),
            0,
            "page {page_number} never had annotations",
        );
    }

    let (count, first_top, last_top) = with_page(engine, document.id, 3, |page| {
        let annotations = page.annotations();

        (
            annotations.len(),
            annotations
                .get(0)
                .expect("the link should survive")
                .bounds()
                .expect("the link should have bounds")
                .top()
                .value,
            annotations
                .get(1)
                .expect("the highlight should survive")
                .bounds()
                .expect("the highlight should have bounds")
                .top()
                .value,
        )
    });

    assert_eq!(count, 2, "both annotations should ride with their page");
    // `/Annots` order survives the move — the session's highlight stays the
    // tail, which is where a mark id resolves its annotation.
    assert!(
        (262.0..=278.0).contains(&first_top),
        "the link sat at top {first_top}",
    );
    assert!(
        (232.0..=248.0).contains(&last_top),
        "the highlight sat at top {last_top}",
    );

    delete_last_mark(engine, document.id, 3)
        .expect("the session's highlight should come off the moved page");

    assert_eq!(
        last_mark(engine, document.id, 3),
        None,
        "the document's own link must stay beyond reach"
    );
    assert_eq!(
        with_page(engine, document.id, 3, |page| page.annotations().len()),
        1,
        "the link should still be on the page"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reorder_keeps_outline_destinations() {
    let engine = test_engine();
    let document = engine
        .open(outlined_three_page_pdf())
        .expect("PDFium should open the outlined PDF");

    assert_eq!(document.outline.len(), 1);
    assert_eq!(
        document.outline[0].page_number,
        Some(3),
        "the bookmark starts on the last page",
    );

    let update = engine
        .reorder_pages(document.id, &[3, 1, 2])
        .expect("PDFium should reorder the pages");

    assert_eq!(
        update.outline.len(),
        1,
        "the bookmark itself should survive"
    );
    assert_eq!(
        update.outline[0].page_number,
        Some(1),
        "the bookmark should resolve to the page's new position",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn delete_then_restore_is_lossless() {
    let engine = test_engine();
    let document = engine
        .open(four_page_banded_pdf())
        .expect("PDFium should open the banded PDF");

    engine
        .add_highlight(
            document.id,
            2,
            &[quad(20.0, 60.0, 100.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");

    let before = page_fingerprints(engine, document.id, 4);

    // Two non-adjacent pages, one carrying the session's highlight.
    let update = engine
        .delete_pages(document.id, &[2, 4], 7)
        .expect("PDFium should delete the pages");

    assert_eq!(update.num_pages, 2);

    let between = page_fingerprints(engine, document.id, 2);

    assert_eq!(between[0], before[0], "page 1 should keep its place");
    assert_eq!(between[1], before[2], "old page 3 should close the gap");

    let update = engine
        .restore_pages(document.id, 7)
        .expect("PDFium should restore the pages");

    assert_eq!(update.num_pages, 4);
    assert_eq!(
        page_fingerprints(engine, document.id, 4),
        before,
        "a delete and restore should be lossless, highlight and all",
    );

    delete_last_mark(engine, document.id, 2)
        .expect("the restored highlight should still be the session's to remove");

    let error = engine
        .restore_pages(document.id, 7)
        .expect_err("a stash is consumed by its restore");

    assert!(error.contains("no stashed pages"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn restore_preserves_the_watermark_guard() {
    let engine = test_engine();
    let document = engine
        .open(four_page_banded_pdf())
        .expect("PDFium should open the banded PDF");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    engine
        .delete_pages(document.id, &[1, 3], 11)
        .expect("PDFium should delete the marked pages");
    engine
        .restore_pages(document.id, 11)
        .expect("the restored pages should still pass the tail preflight");

    engine
        .remove_watermark(document.id)
        .expect("the round-tripped tail should still be removable");

    for page_number in 1..=4 {
        assert_eq!(
            with_page(engine, document.id, page_number, |page| page
                .objects()
                .len()),
            1,
            "page {page_number} should hold only its own band again",
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_delete_every_page() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");

    let error = engine
        .delete_pages(document.id, &[1, 2], 1)
        .expect_err("a document must keep at least one page");

    assert!(error.contains("at least one page"));

    engine
        .delete_pages(document.id, &[2], 1)
        .expect("PDFium should delete the second page");

    let error = engine
        .delete_pages(document.id, &[1], 2)
        .expect_err("the last page must survive");

    assert!(error.contains("at least one page"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn same_stash_id_supports_the_insert_undo_cycle() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");

    // Insert, undo, redo, undo again: the second undo reuses the stash id the
    // redo never consumed, and must replace the leftover stash, not refuse.
    engine
        .insert_blank_page(document.id, 2)
        .expect("PDFium should insert the blank page");
    engine
        .delete_pages(document.id, &[2], 42)
        .expect("the undo should stash the blank page");
    engine
        .insert_blank_page(document.id, 2)
        .expect("the redo should insert a fresh blank page");
    engine
        .delete_pages(document.id, &[2], 42)
        .expect("the second undo should replace the leftover stash");

    let update = engine
        .restore_pages(document.id, 42)
        .expect("the replaced stash should still restore");

    assert_eq!(update.num_pages, 3);

    let error = engine
        .restore_pages(document.id, 9999)
        .expect_err("an unknown stash id has nothing to restore");

    assert!(error.contains("no stashed pages"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inserted_blank_page_matches_its_neighbor() {
    let engine = test_engine();
    let document = engine
        .open(two_size_pdf())
        .expect("PDFium should open the two-size PDF");

    let update = engine
        .insert_blank_page(document.id, 1)
        .expect("PDFium should insert at the front");

    assert_eq!(update.num_pages, 3);
    assert_eq!(
        (update.pages[0].width, update.pages[0].height),
        (200.0, 300.0),
        "a front insert should take the following page's size",
    );

    let update = engine
        .insert_blank_page(document.id, 4)
        .expect("PDFium should insert at the end");

    assert_eq!(update.num_pages, 4);
    assert_eq!(
        (update.pages[3].width, update.pages[3].height),
        (400.0, 500.0),
        "an end insert should take the preceding page's size",
    );

    let fingerprints = page_fingerprints(engine, document.id, 4);

    assert!(
        fingerprints[0].iter().all(|byte| *byte == 0xff),
        "the inserted page should render pure white",
    );

    for (case, index) in [("front", 0), ("end", 6)] {
        let error = engine
            .insert_blank_page(document.id, index)
            .expect_err("an out-of-range position must be refused");

        assert!(
            error.contains("cannot go to position"),
            "the {case} refusal talked about something else: {error}",
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inserted_blank_page_ignores_the_neighbors_rotation() {
    let engine = test_engine();
    let document = engine
        .open(rotated_blank_pdf(90))
        .expect("PDFium should open the rotated PDF");

    // The neighbour displays 300x200 through its /Rotate 90; the blank page
    // takes its unrotated 200x300 and no rotation of its own.
    let update = engine
        .insert_blank_page(document.id, 1)
        .expect("PDFium should insert the blank page");

    assert_eq!(
        (
            update.pages[0].width,
            update.pages[0].height,
            update.pages[0].rotation,
        ),
        (200.0, 300.0, 0.0),
    );
    assert_eq!(
        (update.pages[1].width, update.pages[1].height),
        (300.0, 200.0),
        "the neighbour still displays through its own rotation",
    );
}

// A blank page inserted into a marked document registers a zero-object entry:
// the guard must accept it, a replacement cover it, a removal lift the rest.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn insert_extends_watermark_state_with_an_empty_entry() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    engine
        .insert_blank_page(document.id, 2)
        .expect("PDFium should insert into the marked document");

    let objects_on = |page_number: i32| {
        with_page(engine, document.id, page_number, |page| {
            page.objects().len()
        })
    };

    assert_eq!(objects_on(1), 1, "the first page carries its mark");
    assert_eq!(objects_on(2), 0, "the inserted page is bare");
    assert_eq!(objects_on(3), 1, "the last page carries its mark");

    engine
        .apply_watermark(document.id, watermark_config("FINAL"))
        .expect("the replacement should accept the bare page");

    assert!(
        objects_on(2) > 0,
        "the replacement should cover the inserted page"
    );

    engine
        .remove_watermark(document.id)
        .expect("the removal should lift every owned object");

    for page_number in 1..=3 {
        assert_eq!(
            objects_on(page_number),
            0,
            "page {page_number} should be clean"
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn structure_change_invalidates_a_captured_rect_effect() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");
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

    // Each structure operation must bump every page: an M5 effect captured
    // before it processes unlocked, and its commit has to be refused.
    let captured = revisions();

    engine
        .reorder_pages(document.id, &[2, 1])
        .expect("PDFium should reorder the pages");

    let after_reorder = revisions();

    assert!(
        captured.iter().zip(&after_reorder).all(|(a, b)| a != b),
        "a reorder should invalidate every page",
    );

    engine
        .insert_blank_page(document.id, 1)
        .expect("PDFium should insert the blank page");

    let after_insert = revisions();

    assert!(
        after_reorder
            .iter()
            .zip(&after_insert[1..])
            .all(|(a, b)| a != b),
        "an insert should invalidate every existing page",
    );

    engine
        .delete_pages(document.id, &[1], 3)
        .expect("PDFium should delete the blank page");

    let after_delete = revisions();

    assert!(
        after_insert[1..]
            .iter()
            .zip(&after_delete)
            .all(|(a, b)| a != b),
        "a delete should invalidate every remaining page",
    );

    engine
        .restore_pages(document.id, 3)
        .expect("PDFium should restore the blank page");

    let after_restore = revisions();

    assert!(
        after_delete
            .iter()
            .zip(&after_restore[1..])
            .all(|(a, b)| a != b),
        "a restore should invalidate every page",
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn deleting_pages_marks_compaction() {
    let engine = test_engine();
    let directory = scratch_directory("page-delete-compaction");
    let full = directory.join("full.pdf");
    let trimmed = directory.join("trimmed.pdf");
    let document = engine
        .open(heavy_second_page_pdf())
        .expect("PDFium should open the heavy PDF");

    engine
        .save_to(document.id, &full)
        .expect("the untouched document should save");
    engine
        .delete_pages(document.id, &[2], 1)
        .expect("PDFium should delete the heavy page");
    engine
        .save_to(document.id, &trimmed)
        .expect("the trimmed document should save");

    let full_size = fs::metadata(&full)
        .expect("the full save should exist")
        .len();
    let trimmed_size = fs::metadata(&trimmed)
        .expect("the trimmed save should exist")
        .len();

    assert!(
        trimmed_size + 500 < full_size,
        "compaction should reclaim the deleted page's content ({full_size} -> {trimmed_size})",
    );

    let reopened = engine
        .open(fs::read(&trimmed).expect("the trimmed save should read back"))
        .expect("the trimmed save should reopen");

    assert_eq!(reopened.num_pages, 1, "the deletion should persist");
    fs::remove_dir_all(directory).ok();
}
