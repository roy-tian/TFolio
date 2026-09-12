use super::support::*;
use super::*;
use crate::pdfium::watermark::{WatermarkDirection, WatermarkLayout};

// Two backgrounds with very different luminance: an alpha spike over both
// proves source-over compositing rather than a colour pre-mixed for white.
fn watermark_background_pdf() -> Vec<u8> {
    let content = "0.85 g\n0 0 100 300 re f\n0.2 g\n100 0 100 300 re f\n";
    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
        ];

    build_pdf(&objects)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_is_semi_transparent() {
    let engine = test_engine();
    let render_case = |alpha: Option<u8>| {
        let document = engine
            .open(watermark_background_pdf())
            .expect("PDFium should open the watermark fixture");

        if let Some(alpha) = alpha {
            let mut documents = engine
                .documents
                .lock()
                .expect("the document store should be usable");
            let entry = documents
                .get_mut(&document.id)
                .expect("the watermark fixture should still be open");
            let font = entry.document.fonts_mut().helvetica();
            let mut object =
                PdfPageTextObject::new(&entry.document, "WATERMARK", font, PdfPoints::new(42.0))
                    .expect("PDFium should create the watermark text");

            object
                .set_fill_color(PdfColor::RED.with_alpha(alpha))
                .expect("PDFium should accept the watermark alpha");
            object
                .translate(PdfPoints::new(4.0), PdfPoints::new(130.0))
                .expect("PDFium should place the watermark text");

            let mut page = entry
                .document
                .pages_mut()
                .get(0)
                .expect("the watermark fixture should have a page");
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            page.objects_mut()
                .add_text_object(object)
                .expect("PDFium should append the watermark text");
            page.regenerate_content()
                .expect("PDFium should regenerate the watermarked page");
        }

        let bytes = {
            let documents = engine
                .documents
                .lock()
                .expect("the document store should be usable");
            documents[&document.id]
                .document
                .save_to_bytes()
                .expect("PDFium should save the alpha spike")
        };
        engine
            .close(document.id)
            .expect("the source fixture should close");

        let reopened = engine
            .open(bytes)
            .expect("PDFium should reopen the alpha spike");
        let image = image::load_from_memory(
            &engine
                .render_page(reopened.id, 1, 400)
                .expect("PDFium should render the reopened alpha spike"),
        )
        .expect("the alpha spike should be a PNG")
        .into_rgb8();
        engine
            .close(reopened.id)
            .expect("the reopened fixture should close");

        image
    };

    let without = render_case(None);
    let half = render_case(Some(128));
    let opaque = render_case(Some(255));
    let mut samples = [0usize; 2];
    let mut error = [0.0f64; 2];

    for (x, y, base) in without.enumerate_pixels() {
        let full = opaque.get_pixel(x, y);
        let difference = base
            .0
            .iter()
            .zip(full.0)
            .map(|(base, full)| (*base as i16 - full as i16).unsigned_abs() as u32)
            .sum::<u32>();

        // Ignore untouched background and antialiasing's faintest fringe;
        // the remaining glyph pixels have a meaningful opaque endpoint.
        if difference < 30 {
            continue;
        }

        let side = usize::from(x >= without.width() / 2);
        let semi = half.get_pixel(x, y);

        for channel in 0..3 {
            let expected = base[channel] as f64
                + (full[channel] as f64 - base[channel] as f64) * (128.0 / 255.0);
            error[side] += (semi[channel] as f64 - expected).abs();
        }
        samples[side] += 1;
    }

    for (side, label) in ["light", "dark"].into_iter().enumerate() {
        assert!(
            samples[side] > 100,
            "the watermark did not cover enough of the {label} background"
        );
        let mean_error = error[side] / (samples[side] * 3) as f64;
        assert!(
                mean_error < 3.0,
                "the 50% watermark did not alpha-blend over the {label} background; mean channel error was {mean_error}"
            );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_saved_watermark_reopens_as_plain_page_content() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the watermark fixture");
    let clean = rendered_darkness(engine, document.id, 1);
    let directory = scratch_directory("watermark-reopen");
    let destination = directory.join("watermark.pdf");

    engine
        .apply_watermark(document.id, watermark_config("ARCHIVE"))
        .expect("PDFium should apply the watermark");
    engine
        .save_to(document.id, &destination)
        .expect("the watermark should reach the file");

    let reopened = engine
        .open(fs::read(&destination).expect("the saved file should be readable"))
        .expect("PDFium should reopen the saved file");

    assert!(
        rendered_darkness(engine, reopened.id, 1) > clean,
        "the reopened file should still render the watermark"
    );
    assert!(
        engine.remove_watermark(reopened.id).is_err(),
        "a reopened watermark is input content, not this session's to remove"
    );

    fs::remove_dir_all(directory).ok();
}

/// A tiled row sits on one baseline, where PDFium's extraction starts
/// separating runs — the case that broke the tiled watermark ownership check.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn tiles_sharing_a_baseline_keep_one_identity() {
    let engine = test_engine();

    for rotation in [0, 90, 180, 270] {
        for direction in [
            WatermarkDirection::Ascending,
            WatermarkDirection::Descending,
        ] {
            let label = format!("rotation {rotation} {direction:?}");
            let document = engine
                .open(rotated_blank_pdf(rotation))
                .expect("PDFium should open the watermark fixture");
            let mut config = watermark_config("SPECIMEN");
            config.layout = WatermarkLayout::Zebra;
            config.direction = direction;
            config.width_ratio = 0.2;

            engine
                .apply_watermark(document.id, config)
                .unwrap_or_else(|error| panic!("{label} should tile: {error}"));

            // The guard has to still recognise what it wrote: a replace reads
            // the tail back before it touches anything.
            let mut replacement = watermark_config("SPECIMEN II");
            replacement.layout = WatermarkLayout::Zebra;
            replacement.direction = direction;
            replacement.width_ratio = 0.2;
            engine
                .apply_watermark(document.id, replacement)
                .unwrap_or_else(|error| panic!("{label} should stay owned: {error}"));
            engine
                .remove_watermark(document.id)
                .unwrap_or_else(|error| panic!("{label} should stay removable: {error}"));
        }
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn applies_a_watermark_to_every_page() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    let mut progress = Vec::new();
    engine
        .apply_watermark_with_progress(
            document.id,
            watermark_config("DRAFT"),
            |completed, total| progress.push((completed, total)),
        )
        .expect("PDFium should apply the watermark");

    assert_eq!(progress, [(0, 4), (1, 4), (2, 4), (3, 4), (4, 4)]);

    for page_number in 1..=2 {
        assert!(
            rendered_darkness(engine, document.id, page_number) > 0,
            "page {page_number} should render watermark ink"
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn places_watermark_in_display_space_on_rotated_pages() {
    let engine = test_engine();

    for rotation in [0, 90, 180, 270] {
        let document = engine
            .open(rotated_blank_pdf(rotation))
            .expect("PDFium should open the rotated watermark fixture");
        let mut config = watermark_config("DISPLAY DIRECTION");
        config.width_ratio = 0.9;

        engine
            .apply_watermark(document.id, config)
            .expect("PDFium should apply a display-space watermark");
        let image = image::load_from_memory(
            &engine
                .render_page(document.id, 1, 400)
                .expect("PDFium should render the rotated watermark"),
        )
        .expect("the rotated watermark should be a PNG")
        .into_rgb8();
        let mut left = image.width();
        let mut right = 0;
        let mut top = image.height();
        let mut bottom = 0;
        let mut ink = 0usize;

        for (x, y, pixel) in image.enumerate_pixels() {
            if pixel.0.iter().any(|channel| *channel < 220) {
                left = left.min(x);
                right = right.max(x);
                top = top.min(y);
                bottom = bottom.max(y);
                ink += 1;
            }
        }

        assert!(ink > 100, "rotation {rotation} rendered too little text");

        // The mark leans along the displayed diagonal, so its box keeps the
        // displayed sheet's shape; angled from the unrotated box it clips squarer.
        let drawn = f64::from(bottom - top) / f64::from(right - left);
        let displayed = f64::from(image.height()) / f64::from(image.width());

        assert!(
            (drawn - displayed).abs() < 0.15,
            "rotation {rotation} drew a {drawn:.2} box on a {displayed:.2} page"
        );
        assert!(
            f64::from(right - left) > f64::from(image.width()) * 0.7,
            "rotation {rotation} drew a mark narrower than the share it was given"
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_text_is_extractable() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the watermark fixture");

    engine
        .apply_watermark(document.id, watermark_config("SEARCHABLE WATERMARK"))
        .expect("PDFium should apply the watermark");

    let extracted = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract page content")
        .into_iter()
        .map(|span| span.text)
        .collect::<String>();

    assert!(extracted.contains("SEARCHABLE WATERMARK"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn latin_watermark_uses_the_standard_sans_face() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the watermark fixture");
    let mut config = watermark_config("STANDARD WATERMARK");
    config.width_ratio = 0.5;

    engine
        .apply_watermark(document.id, config)
        .expect("PDFium should apply a standard-face watermark");
    let bytes = {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        documents[&document.id]
            .document
            .save_to_bytes()
            .expect("PDFium should save the standard-face watermark")
    };

    assert!(
        bytes
            .windows(b"Helvetica".len())
            .any(|window| window == b"Helvetica"),
        "a Latin watermark should use PDF's standard sans face"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn one_cjk_subset_serves_the_whole_document() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_watermark(document.id, watermark_config("内部资料"))
        .expect("PDFium should apply one CJK watermark across the document");
    let bytes = {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        documents[&document.id]
            .document
            .save_to_bytes()
            .expect("PDFium should save the CJK watermark")
    };
    let embedded_fonts = bytes
        .windows(b"/FontFile2".len())
        .filter(|window| *window == b"/FontFile2")
        .count();

    assert_eq!(
        embedded_fonts, 1,
        "all pages should reference one document-level CJK subset"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn removes_exactly_what_it_added() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    let before = (1..=2)
        .map(|page_number| {
            engine
                .render_page(document.id, page_number, 400)
                .expect("PDFium should render the original page")
        })
        .collect::<Vec<_>>();

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    engine
        .remove_watermark(document.id)
        .expect("PDFium should remove the watermark");

    for (index, expected) in before.iter().enumerate() {
        assert_eq!(
            engine
                .render_page(document.id, index as i32 + 1, 400)
                .expect("PDFium should render the restored page"),
            *expected,
            "removing a watermark should restore page {} bit-for-bit",
            index + 1
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn replacing_a_watermark_does_not_stack() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply watermark A");
    let objects_after_a = with_page(engine, document.id, 1, |page| page.objects().len());

    engine
        .apply_watermark(document.id, watermark_config("FINAL"))
        .expect("PDFium should replace watermark A with B");
    let objects_after_b = with_page(engine, document.id, 1, |page| page.objects().len());
    let extracted = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract the replacement text")
        .into_iter()
        .map(|span| span.text)
        .collect::<String>();

    assert_eq!(objects_after_b, objects_after_a);
    assert!(extracted.contains("FINAL"));
    assert!(!extracted.contains("DRAFT"));

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should restore watermark A");
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.objects().len()),
        objects_after_a
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_remove_page_content_it_did_not_add() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");
    let first_page_objects = with_page(engine, document.id, 1, |page| page.objects().len());

    // Simulate another editor appending content after this session's tail.
    // The second page fails preflight; the first must not already be changed.
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
        .remove_watermark(document.id)
        .expect_err("foreign page content must invalidate the ownership guard");

    assert!(error.contains("no longer ends"));
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.objects().len()),
        first_page_objects,
        "whole-document preflight must fail before page one is changed"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn save_reload_preserves_the_watermark_guard() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let before = engine
        .render_page(document.id, 1, 400)
        .expect("PDFium should render the original page");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply watermark A");
    engine
        .apply_watermark(document.id, watermark_config("FINAL"))
        .expect("PDFium should replace watermark A");

    let directory = scratch_directory("watermark-guard");
    let destination = directory.join("watermark.pdf");
    engine
        .save_to(document.id, &destination)
        .expect("the compacting save should preserve ownership");
    engine
        .remove_watermark(document.id)
        .expect("the reloaded owned tail should remain removable");

    assert_eq!(
        engine
            .render_page(document.id, 1, 400)
            .expect("PDFium should render the restored page"),
        before
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn repeated_replacements_are_compacted_on_save() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");
    let directory = scratch_directory("watermark-compaction");
    let single = directory.join("single.pdf");
    let replaced = directory.join("replaced.pdf");

    engine
        .apply_watermark(document.id, watermark_config("内部资料"))
        .expect("PDFium should apply the first CJK watermark");
    engine
        .save_to(document.id, &single)
        .expect("PDFium should save one CJK watermark");
    let single_size = fs::metadata(&single).unwrap().len();

    for (index, text) in ["内部文件", "仅供审阅", "请勿外传", "最终版本"]
        .into_iter()
        .enumerate()
    {
        let mut config = watermark_config(text);
        config.width_ratio = if index % 2 == 0 { 0.6 } else { 0.8 };
        engine
            .apply_watermark(document.id, config)
            .expect("PDFium should replace the CJK watermark");
    }
    engine
        .save_to(document.id, &replaced)
        .expect("the save should collect replaced watermark resources");
    let replaced_bytes = fs::read(&replaced).unwrap();
    let replaced_fonts = replaced_bytes
        .windows(b"/FontFile2".len())
        .filter(|window| *window == b"/FontFile2")
        .count();

    assert_eq!(replaced_fonts, 1, "only the live CJK subset should remain");
    assert!(
        replaced_bytes.len() as u64 <= single_size * 2,
        "replacement resources grew from {single_size} to {} bytes",
        replaced_bytes.len()
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_change_invalidates_a_captured_rect_effect() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the revision fixture");
    let revision = || {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = &documents[&document.id];
        let page_id = entry.page_ids[0];

        entry.revisions.get(&page_id).copied().unwrap_or(0)
    };
    let captured = revision();

    engine
        .apply_watermark(document.id, watermark_config("REVISION"))
        .expect("PDFium should apply the watermark");
    assert_ne!(
        revision(),
        captured,
        "an effect captured before apply must fail its revision check"
    );
    let captured_with_watermark = revision();

    engine
        .remove_watermark(document.id)
        .expect("PDFium should remove the watermark");
    assert_ne!(
        revision(),
        captured_with_watermark,
        "an effect captured before removal must fail its revision check"
    );
}
