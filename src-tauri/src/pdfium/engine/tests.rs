use super::*;

use crate::pdfium::library::PDFIUM_LIBRARY_NAME;
use crate::pdfium::watermark::{WatermarkFontFamily, WatermarkLayout};

/// Serialises `objects` into a PDF. Shared by the fixtures below, which
/// differ only in the objects they describe.
fn build_pdf(objects: &[String]) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();

    for object in objects {
        offsets.push(pdf.len());
        pdf.extend_from_slice(object.as_bytes());
    }

    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");

    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }

    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    pdf
}

// A portrait 200x300 page with `/Rotate 90` and the text "Hi" drawn at an
// unrotated baseline of (50, 250).
fn rotated_text_pdf() -> Vec<u8> {
    let content = "BT\n/F1 24 Tf\n50 250 Td\n(Hi) Tj\nET\n";
    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
            "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
        ];
    build_pdf(&objects)
}

// PDFium can only be bound once per process, so share a single leaked
// instance across the (otherwise independent) test engines.
fn test_pdfium() -> &'static Pdfium {
    static PDFIUM: std::sync::OnceLock<&'static Pdfium> = std::sync::OnceLock::new();

    PDFIUM.get_or_init(|| {
        let library_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium")
            .join(PDFIUM_LIBRARY_NAME);
        let bindings = Pdfium::bind_to_library(&library_path)
            .unwrap_or_else(|error| panic!("could not load {}: {error}", library_path.display()));

        Box::leak(Box::new(Pdfium::new(bindings)))
    })
}

/// The one engine every test shares, mirroring the app's single
/// `PdfiumState`.
///
/// An engine each would be a lock each (see `PdfiumEngine::documents`), and
/// the harness runs tests in parallel — which corrupts the heap.
fn test_engine() -> &'static PdfiumEngine {
    static ENGINE: std::sync::OnceLock<PdfiumEngine> = std::sync::OnceLock::new();

    ENGINE.get_or_init(|| PdfiumEngine {
        pdfium: test_pdfium(),
        documents: Mutex::new(HashMap::new()),
        next_document_id: AtomicU64::new(1),
        // Straight from the source tree: the tests have no `AppHandle` to
        // resolve a bundled resource through.
        cjk_font_path: Some(crate::pdfium::font::bundled_cjk_font_path()),
        cjk_font: OnceLock::new(),
        cjk_bold_font: OnceLock::new(),
        approved_paths: Mutex::new(HashSet::new()),
    })
}

/// Hands `inspect` a page with the store locked, which is the only way a test
/// may look at one: loading and dropping a page is PDFium work like any
/// other. The page drops before the guard, so nothing reaches PDFium
/// unlocked.
fn with_page<T>(
    engine: &PdfiumEngine,
    document_id: u64,
    page_number: i32,
    inspect: impl FnOnce(&PdfPage<'_>) -> T,
) -> T {
    let documents = engine
        .documents
        .lock()
        .expect("the document store should be usable");
    let page = documents[&document_id]
        .document
        .pages()
        .get(page_number - 1)
        .expect("the document should have the page");

    inspect(&page)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn extracts_text_in_unrotated_space_for_rotated_page() {
    let engine = test_engine();
    let document = engine
        .open(rotated_text_pdf())
        .expect("PDFium should open the rotated PDF");

    // `/Rotate 90` is surfaced so the frontend can orient the text layer.
    assert_eq!(document.pages[0].rotation, 90.0);

    let spans = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract text");
    assert_eq!(spans.len(), 1, "the page has a single text run");

    let span = &spans[0];
    assert_eq!(span.text, "Hi");
    // Bounds stay in the unrotated 200x300 page space with a top-left
    // origin: the run sits near x=52, and the top-flip uses the unrotated
    // height (300), not the displayed height (200) — which would go negative.
    assert!((50.0..55.0).contains(&span.left), "left was {}", span.left);
    assert!((30.0..36.0).contains(&span.top), "top was {}", span.top);
    assert!(span.width > 0.0 && span.top > 0.0);
}

fn minimal_pdf() -> Vec<u8> {
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ];
    build_pdf(&objects)
}

// Two backgrounds with very different luminance make the watermark alpha
// spike prove source-over compositing rather than a colour pre-mixed for a
// white page. The text added by the test spans both halves.
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

fn two_page_pdf() -> Vec<u8> {
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n"
                .to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
            "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
            "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ];

    build_pdf(&objects)
}

fn rotated_blank_pdf(rotation: i32) -> Vec<u8> {
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate {rotation} /Contents 4 0 R >>\nendobj\n"
            ),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ];

    build_pdf(&objects)
}

fn watermark_config(text: &str) -> WatermarkConfig {
    WatermarkConfig {
        text: text.into(),
        font_family: WatermarkFontFamily::Sans,
        font_size: 36.0,
        bold: false,
        color: "#ef4444".into(),
        opacity: 0.35,
        rotation: -30.0,
        layout: WatermarkLayout::Single,
        spacing: 54.0,
    }
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

/// The bytes really carry the watermark — and the reopened document does
/// not carry the ownership that would let this app lift it again.
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

/// A tiled row sits on one baseline, which is where PDFium's extraction
/// starts separating runs — the case that made every near-horizontal tiled
/// watermark fail its own ownership check.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn tiles_sharing_a_baseline_keep_one_identity() {
    let engine = test_engine();

    for rotation in [0.0, 5.0, 90.0, 180.0, -30.0] {
        let document = engine
            .open(minimal_pdf())
            .expect("PDFium should open the watermark fixture");
        let mut config = watermark_config("SPECIMEN");
        config.layout = WatermarkLayout::Zebra;
        config.font_size = 12.0;
        config.rotation = rotation;

        engine
            .apply_watermark(document.id, config)
            .unwrap_or_else(|error| panic!("rotation {rotation} should tile: {error}"));

        // The guard has to still recognise what it wrote: a replace reads
        // the tail back before it touches anything.
        let mut replacement = watermark_config("SPECIMEN");
        replacement.layout = WatermarkLayout::Zebra;
        replacement.font_size = 12.0;
        replacement.rotation = rotation;
        replacement.color = "#000000".into();
        engine
            .apply_watermark(document.id, replacement)
            .unwrap_or_else(|error| panic!("rotation {rotation} should stay owned: {error}"));
        engine
            .remove_watermark(document.id)
            .unwrap_or_else(|error| panic!("rotation {rotation} should stay removable: {error}"));
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn applies_a_watermark_to_every_page() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the two-page fixture");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");

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
        config.color = "#000000".into();
        config.font_size = 42.0;
        config.opacity = 1.0;
        config.rotation = 0.0;

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
        assert!(
            right - left > (bottom - top) * 3,
            "rotation {rotation} did not leave a zero-degree watermark horizontal: bbox {}x{}",
            right - left,
            bottom - top
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
fn latin_bold_watermark_uses_the_standard_bold_face() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the watermark fixture");
    let mut config = watermark_config("BOLD WATERMARK");
    config.bold = true;

    engine
        .apply_watermark(document.id, config)
        .expect("PDFium should apply a bold watermark");
    let bytes = {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        documents[&document.id]
            .document
            .save_to_bytes()
            .expect("PDFium should save the bold watermark")
    };

    assert!(
        bytes
            .windows(b"Helvetica-Bold".len())
            .any(|window| window == b"Helvetica-Bold"),
        "the Latin bold watermark should use PDF's standard bold face"
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

    // Applying the previous configuration is the backend half of undoing a
    // replace: one object remains, now carrying A again.
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
        config.color = if index % 2 == 0 {
            "#2563eb".into()
        } else {
            "#dc2626".into()
        };
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

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn opens_and_renders_pdf_with_pdfium() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    assert_eq!(document.num_pages, 1);
    assert_eq!(document.pages.len(), 1);

    let png = engine
        .render_page(document.id, 1, 400)
        .expect("PDFium should render the page");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    // The minimal PDF carries no page content, so it has no selectable text.
    let spans = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract text");
    assert!(spans.is_empty());
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn renders_thumbnail_as_webp() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let webp = engine
        .render_thumbnail(document.id, 1, 200)
        .expect("PDFium should render the thumbnail");

    // RIFF container magic, with the four-byte file size in between.
    assert_eq!(&webp[..4], b"RIFF");
    assert_eq!(&webp[8..12], b"WEBP");

    // Thumbnails are capped well below the full-page render ceiling.
    let error = engine
        .render_thumbnail(document.id, 1, MAX_THUMBNAIL_WIDTH + 1)
        .expect_err("thumbnails wider than the cap are rejected");
    assert!(error.contains("render width must be between"));
}

fn quad(left: f32, top: f32, width: f32, height: f32) -> PagePointsRect {
    PagePointsRect {
        height,
        left,
        top,
        width,
    }
}

fn rect_style(
    stroke: Option<&str>,
    fill: Option<&str>,
    opacity: f32,
    corner_radius: f32,
    stroke_width: f32,
) -> RectStyle {
    RectStyle {
        stroke_color: stroke.map(str::to_string),
        fill_color: fill.map(str::to_string),
        opacity,
        corner_radius,
        stroke_width,
    }
}

fn rect_effect(kind: RectEffectKind, strength: f32) -> RectEffect {
    RectEffect { kind, strength }
}

// Stands in for the links, form fields, and comments a real document
// arrives with.
fn link_pdf() -> Vec<u8> {
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [5 0 R] /Contents 4 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
            "5 0 obj\n<< /Type /Annot /Subtype /Link /Rect [10 250 90 270] /Border [0 0 0] >>\nendobj\n".to_string(),
        ];

    build_pdf(&objects)
}

// An upright 200x300 page with "Hello" drawn at a baseline of (50, 250), so
// there is real ink for a highlight to sit over.
fn text_pdf() -> Vec<u8> {
    let content = "BT\n/F1 24 Tf\n50 250 Td\n(Hello) Tj\nET\n";
    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
            "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
        ];
    build_pdf(&objects)
}

// Dense vertical bars inside (40,70)-(160,170) in top-left page space.
// Their short period gives mosaic and blur a high-frequency signal to
// reduce, while the untouched white margin catches an effect placed wide.
fn striped_pdf_with_rotation(rotation: Option<i32>) -> Vec<u8> {
    let mut content = "0 0 0 rg\n".to_string();

    for left in (40..160).step_by(4) {
        content.push_str(&format!("{left} 130 2 100 re f\n"));
    }

    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let rotation = rotation
        .map(|degrees| format!("/Rotate {degrees} "))
        .unwrap_or_default();
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] {rotation}/Contents 4 0 R >>\nendobj\n"
            ),
            contents_obj,
        ];

    build_pdf(&objects)
}

fn striped_pdf() -> Vec<u8> {
    striped_pdf_with_rotation(None)
}

fn rotated_striped_pdf() -> Vec<u8> {
    striped_pdf_with_rotation(Some(90))
}

// Four asymmetric colour fields inside the rectangle-effect target. A test
// that only checks the target band cannot distinguish the two quarter-turn
// counter-rotations; these fields make the content's orientation observable.
fn quadrant_pdf(rotation: i32) -> Vec<u8> {
    let content = concat!(
        "1 0 0 rg\n40 180 60 50 re f\n",
        "0 1 0 rg\n100 180 60 50 re f\n",
        "0 0 1 rg\n40 130 60 50 re f\n",
        "1 1 0 rg\n100 130 60 50 re f\n",
    );
    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );

    build_pdf(&[
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate {rotation} /Contents 4 0 R >>\nendobj\n"
            ),
            contents_obj,
        ])
}

fn a4_striped_pdf() -> Vec<u8> {
    let mut content = "0 0 0 rg\n".to_string();

    for left in (0..595).step_by(4) {
        content.push_str(&format!("{left} 0 2 842 re f\n"));
    }

    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    build_pdf(&[
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
        ])
}

/// A page point is two device pixels on the 200x300 fixtures at this width.
const TEST_RENDER_WIDTH: i32 = 400;

/// How much ink a render of `page_number` puts on the page, and where.
///
/// Off the pixels rather than the annotation list: an annotation PDFium has
/// stored but will not draw counts the same as one that works. Split by
/// region rather than totalled: a highlight at the wrong end of the page
/// puts down exactly as much ink as one at the right end.
fn ink_inside_and_outside(
    engine: &PdfiumEngine,
    document_id: u64,
    page_number: i32,
    band: (u32, u32, u32, u32),
) -> (u64, u64) {
    let image = engine
        .render_bitmap(
            document_id,
            page_number,
            TEST_RENDER_WIDTH,
            MAX_RENDER_WIDTH,
        )
        .expect("PDFium should render the page")
        .into_rgb8();
    let (left, top, right, bottom) = band;
    let mut inside = 0;
    let mut outside = 0;

    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue] = pixel.0;
        let ink = (255 - red) as u64 + (255 - green) as u64 + (255 - blue) as u64;

        if x >= left && x < right && y >= top && y < bottom {
            inside += ink;
        } else {
            outside += ink;
        }
    }

    (inside, outside)
}

fn rendered_rgb(engine: &PdfiumEngine, document_id: u64) -> image::RgbImage {
    engine
        .render_bitmap(document_id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
        .expect("PDFium should render the page")
        .into_rgb8()
}

fn color_at_unrotated_point(image: &image::RgbImage, point: (f32, f32), rotation: i32) -> [u8; 3] {
    let (x, top) = point;
    let (displayed_x, displayed_y, displayed_width, displayed_height) = match rotation {
        90 => (300.0 - top, x, 300.0, 200.0),
        180 => (200.0 - x, 300.0 - top, 200.0, 300.0),
        270 => (top, 200.0 - x, 300.0, 200.0),
        _ => (x, top, 200.0, 300.0),
    };
    let pixel_x = ((displayed_x / displayed_width) * image.width() as f32)
        .floor()
        .clamp(0.0, image.width().saturating_sub(1) as f32) as u32;
    let pixel_y = ((displayed_y / displayed_height) * image.height() as f32)
        .floor()
        .clamp(0.0, image.height().saturating_sub(1) as f32) as u32;

    image.get_pixel(pixel_x, pixel_y).0
}

fn color_difference(actual: [u8; 3], expected: [u8; 3]) -> u16 {
    actual
        .into_iter()
        .zip(expected)
        .map(|(left, right)| left.abs_diff(right) as u16)
        .sum()
}

fn pixel_difference(
    before: &image::RgbImage,
    after: &image::RgbImage,
    band: (u32, u32, u32, u32),
) -> (u64, u64) {
    let (left, top, right, bottom) = band;
    let mut inside = 0;
    let mut outside = 0;

    for (x, y, pixel) in before.enumerate_pixels() {
        let next = after.get_pixel(x, y);
        let difference = pixel
            .0
            .into_iter()
            .zip(next.0)
            .map(|(a, b)| a.abs_diff(b) as u64)
            .sum::<u64>();

        if x >= left && x < right && y >= top && y < bottom {
            inside += difference;
        } else {
            outside += difference;
        }
    }

    (inside, outside)
}

fn horizontal_edge_energy(image: &image::RgbImage, band: (u32, u32, u32, u32)) -> u64 {
    let (left, top, right, bottom) = band;
    let mut energy = 0;

    for y in top..bottom {
        for x in (left + 1)..right {
            let previous = image.get_pixel(x - 1, y).0[0];
            let current = image.get_pixel(x, y).0[0];
            energy += previous.abs_diff(current) as u64;
        }
    }

    energy
}

fn luminance_variance(image: &image::RgbImage, band: (u32, u32, u32, u32)) -> f64 {
    let (left, top, right, bottom) = band;
    let mut values = Vec::new();

    for y in top..bottom {
        for x in left..right {
            let [red, green, blue] = image.get_pixel(x, y).0;
            values.push((red as f64 + green as f64 + blue as f64) / 3.0);
        }
    }

    let mean = values.iter().sum::<f64>() / values.len() as f64;
    values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64
}

#[test]
fn maps_unrotated_effect_bounds_into_the_rendered_page() {
    let bounds = quad(10.0, 20.0, 30.0, 40.0);

    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 0.0),
        DisplayRect {
            height: 40.0,
            left: 10.0,
            top: 20.0,
            width: 30.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 90.0),
        DisplayRect {
            height: 30.0,
            left: 240.0,
            top: 10.0,
            width: 40.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 180.0),
        DisplayRect {
            height: 40.0,
            left: 160.0,
            top: 240.0,
            width: 30.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 270.0),
        DisplayRect {
            height: 30.0,
            left: 20.0,
            top: 160.0,
            width: 40.0,
        }
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_changes_the_covered_pixels() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let band = (80, 140, 320, 340);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic");

    let after = rendered_rgb(engine, document.id);
    let (inside, outside) = pixel_difference(&before, &after, band);

    assert!(
        inside > 100_000,
        "the mosaic did not change its band: {inside}"
    );
    assert_eq!(outside, 0, "the mosaic changed pixels outside its band");

    engine
        .delete_last_annotation(document.id, 1)
        .expect("PDFium should remove the mosaic");
    assert_eq!(
        rendered_rgb(engine, document.id),
        before,
        "undoing the mosaic should restore every page pixel"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_lands_in_unrotated_space_on_a_rotated_page() {
    let engine = test_engine();
    let document = engine
        .open(rotated_striped_pdf())
        .expect("PDFium should open the rotated striped PDF");
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(40.0, 70.0, 120.0, 100.0),
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic in unrotated page space");

    // The unrotated box becomes (130,40)-(230,160) after `/Rotate 90`.
    // At 400px across the 300pt displayed width, this is the band below.
    let after = rendered_rgb(engine, document.id);
    let (inside, outside) = pixel_difference(&before, &after, (170, 50, 310, 217));

    assert!(
        inside > 100_000,
        "the rotated mosaic changed no source pixels"
    );
    assert_eq!(
        outside, 0,
        "the rotated mosaic landed outside its mapped band"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rectangle_effect_preserves_content_orientation_for_rotated_pages() {
    let engine = test_engine();
    let samples = [
        ((70.0, 95.0), [255, 0, 0]),
        ((130.0, 95.0), [0, 255, 0]),
        ((70.0, 145.0), [0, 0, 255]),
        ((130.0, 145.0), [255, 255, 0]),
    ];

    for rotation in [90, 180, 270] {
        let document = engine
            .open(quadrant_pdf(rotation))
            .expect("PDFium should open the quadrant PDF");
        let before = rendered_rgb(engine, document.id);

        engine
            .add_rect_effect(
                document.id,
                1,
                &quad(40.0, 70.0, 120.0, 100.0),
                &rect_effect(RectEffectKind::Mosaic, MIN_RECT_EFFECT_STRENGTH),
            )
            .expect("PDFium should add the rotated mosaic");

        let after = rendered_rgb(engine, document.id);

        for (point, expected) in samples {
            let before_color = color_at_unrotated_point(&before, point, rotation);
            let after_color = color_at_unrotated_point(&after, point, rotation);

            assert!(
                    color_difference(before_color, expected) < 10,
                    "rotation {rotation} fixture colour at {point:?} was {before_color:?}, expected {expected:?}"
                );
            assert!(
                color_difference(after_color, expected) < 20,
                "rotation {rotation} changed {point:?} to {after_color:?}, expected {expected:?}"
            );
        }
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_makes_the_region_blocky() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let inner_band = (90, 150, 310, 330);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic");

    let after = rendered_rgb(engine, document.id);
    let before_energy = horizontal_edge_energy(&before, inner_band);
    let after_energy = horizontal_edge_energy(&after, inner_band);

    assert!(
        after_energy < before_energy / 3,
        "mosaic blocks did not reduce local edge frequency: {before_energy} -> {after_energy}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn blur_reduces_local_variance() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let inner_band = (100, 160, 300, 320);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Blur, 8.0),
        )
        .expect("PDFium should add the blur");

    let after = rendered_rgb(engine, document.id);
    let before_variance = luminance_variance(&before, inner_band);
    let after_variance = luminance_variance(&after, inner_band);

    assert!(
        after_variance < before_variance / 2.0,
        "blur did not reduce local variance: {before_variance} -> {after_variance}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_does_not_remove_the_underlying_text() {
    let engine = test_engine();
    let document = engine
        .open(text_pdf())
        .expect("PDFium should open the text PDF");
    let before = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract the original text");
    assert!(before.iter().any(|span| span.text.contains("Hello")));

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(40.0, 25.0, 100.0, 50.0),
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add a mosaic over the text");

    let after = engine
        .extract_text(document.id, 1)
        .expect("PDFium should still extract text through the visual effect");
    assert!(
        after.iter().any(|span| span.text.contains("Hello")),
        "the underlying text must remain extractable"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn full_page_mosaic_keeps_the_file_size_bounded() {
    let engine = test_engine();
    let document = engine
        .open(a4_striped_pdf())
        .expect("PDFium should open the A4 striped PDF");

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(0.0, 0.0, 595.0, 842.0),
            &rect_effect(RectEffectKind::Mosaic, MIN_RECT_EFFECT_STRENGTH),
        )
        .expect("PDFium should mosaic the full page");

    let directory = scratch_directory("mosaic-size");
    let destination = directory.join("mosaic.pdf");
    engine
        .save_to(document.id, &destination)
        .expect("PDFium should save the mosaic");
    let size = fs::metadata(&destination)
        .expect("the saved mosaic should exist")
        .len();

    assert!(
        size < 10_000_000,
        "an A4 full-page mosaic grew to {size} bytes"
    );
    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rejects_an_unusable_rectangle_effect() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    for result in [
        engine.add_rect_effect(
            document.id,
            1,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_effect(RectEffectKind::Blur, 1.0),
        ),
        engine.add_rect_effect(
            document.id,
            1,
            &quad(190.0, 10.0, 40.0, 40.0),
            &rect_effect(RectEffectKind::Mosaic, 8.0),
        ),
        engine.add_rect_effect(
            document.id,
            1,
            &quad(10.0, 10.0, 0.0, 40.0),
            &rect_effect(RectEffectKind::Mosaic, 8.0),
        ),
    ] {
        assert!(result.is_err(), "an unusable effect should be rejected");
    }

    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        0,
        "a refused effect should leave no annotation behind"
    );
}

/// The pixel box the page's ink actually occupies, or `None` for a blank
/// page.
///
/// Where `ink_inside_and_outside` asks "did anything land here", this asks
/// "how big is what landed" — which is what tells text drawn at its proper
/// size from the same text drawn shrunk, stretched, or squashed into a
/// corner of the same box. Every one of those puts all its ink inside the
/// band and none outside it.
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

fn rendered_darkness(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> u64 {
    let (inside, outside) = ink_inside_and_outside(engine, document_id, page_number, (0, 0, 0, 0));

    inside + outside
}

// A highlight has to actually be drawn, not merely recorded. PDFium keeps an
// annotation's colour in one of two entries and only draws a highlight from
// one of them, so this is what tells the two apart.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_highlight_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine.open(text_pdf()).expect("PDFium should open the PDF");
    // The quad (45,40)-(155,70) at two pixels per point.
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

    engine
        .delete_last_annotation(document.id, 1)
        .expect("PDFium should remove the highlight");
    assert_eq!(
        ink_inside_and_outside(engine, document.id, 1, band),
        (inside_before, outside_before),
        "removing the highlight should leave the page as it was"
    );
}

// A rectangle, like a highlight, has to land where it was asked for and
// nowhere else. Filled with no border so all its ink is inside its bounds,
// which is what lets the band outside it stay exactly as it was.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_square_where_it_was_asked_for() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    // The box (50,60)-(150,150) at two pixels per point.
    let band = (100, 120, 300, 300);
    let (inside_before, outside_before) = ink_inside_and_outside(engine, document.id, 1, band);

    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 60.0, 100.0, 90.0),
            &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
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

    engine
        .delete_last_annotation(document.id, 1)
        .expect("PDFium should remove the rectangle");
    assert_eq!(
        ink_inside_and_outside(engine, document.id, 1, band),
        (inside_before, outside_before),
        "removing the rectangle should leave the page as it was"
    );
}

// Counting the path's segments proves nothing about what renders — only the
// pixels can say the corner was actually carved. A rounded corner leaves the
// square of page at its very corner emptier than a right angle would.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_rounded_rect() {
    let engine = test_engine();
    // The top-left 25pt corner of a box at (50,50)-(150,150): px (100,100)-(150,150).
    let corner = (100, 100, 150, 150);
    let bounds = quad(50.0, 50.0, 100.0, 100.0);

    let square = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .add_rect(
            square.id,
            1,
            &bounds,
            &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
        )
        .expect("PDFium should create the square-cornered rectangle");
    let (square_corner, _) = ink_inside_and_outside(engine, square.id, 1, corner);

    let rounded = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .add_rect(
            rounded.id,
            1,
            &bounds,
            &rect_style(None, Some("#ff3b30"), 1.0, 25.0, 2.0),
        )
        .expect("PDFium should create the rounded rectangle");
    let (rounded_corner, _) = ink_inside_and_outside(engine, rounded.id, 1, corner);

    assert!(
        rounded_corner < square_corner,
        "the corner was not rounded: rounded {rounded_corner} vs square {square_corner}"
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
            &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
        )
        .expect_err("a rectangle with no area is not a rectangle");
    assert!(error.contains("positive width and height"));

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(f32::NAN, 10.0, 40.0, 40.0),
            &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
        )
        .expect_err("a non-finite coordinate is rejected before it reaches PDFium");
    assert!(error.contains("coordinates are out of range"));

    // A far-off but finite coordinate: refused before it can overflow a page edge.
    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(3.0e38, 0.0, 3.0e38, 40.0),
            &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
        )
        .expect_err("bounds beyond the page range are rejected");
    assert!(error.contains("coordinates are out of range"));

    // Style values outside the sliders' ranges are refused, not clamped: a
    // stroke thinner than 1pt or past 12, a radius past 40, an opacity below the
    // floor or past full — none of them a value the reader could have chosen.
    for style in [
        rect_style(Some("#ff3b30"), None, 1.0, 0.0, 0.0),
        rect_style(Some("#ff3b30"), None, 1.0, 0.0, 13.0),
        rect_style(Some("#ff3b30"), None, 1.0, 41.0, 2.0),
        rect_style(Some("#ff3b30"), Some("#ffcc00"), 0.0, 0.0, 2.0),
        rect_style(Some("#ff3b30"), None, 2.0, 0.0, 2.0),
        rect_style(Some("#ff3b30"), None, f32::MAX, 0.0, 2.0),
    ] {
        let error = engine
            .add_rect(document.id, 1, &quad(10.0, 10.0, 40.0, 40.0), &style)
            .expect_err("a style value outside its range is rejected");
        assert!(
            error.contains("style values are out of range"),
            "wrong rejection: {error}"
        );
    }

    // Both a border and a fill left off: in range, but nothing to draw.
    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_style(None, None, 1.0, 0.0, 2.0),
        )
        .expect_err("a rectangle with neither a border nor a fill draws nothing");
    assert!(error.contains("visible border or fill"));

    let error = engine
        .add_rect(
            document.id,
            1,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_style(Some("not-a-colour"), None, 1.0, 0.0, 2.0),
        )
        .expect_err("a colour PDFium cannot read is rejected");
    assert!(error.contains("not a usable annotation colour"));

    let error = engine
        .add_rect(
            document.id,
            9,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
        )
        .expect_err("a page that does not exist is rejected");
    assert!(error.contains("does not exist"));
}

// A rectangle's flip onto PDFium's axes runs through the same helpers a
// highlight uses, and a `/Rotate` page is where a wrong one shows. Pinned to
// hardcoded values, not read back through the flip that placed it.
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
            &rect_style(Some("#ff3b30"), None, 1.0, 0.0, 2.0),
        )
        .expect("PDFium should create the rectangle");

    let bounds = with_page(engine, document.id, 1, |page| {
        page.annotations()
            .get(0)
            .expect("the rectangle should exist")
            .bounds()
            .expect("the rectangle should have bounds")
    });

    // The fixture's unrotated height is 300pt. A box 30pt down from the top,
    // 50pt tall, sits 220..270pt up from the bottom; 40pt in, 60pt wide, at
    // 40..100. Against those figures, not against the input fed back.
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
    // A fill-only box at (50,60)-(150,150): px band (100,120)-(300,300). No
    // border, so every drawn pixel is inside the bounds.
    let band = (100, 120, 300, 300);
    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 60.0, 100.0, 90.0),
            &rect_style(None, Some("#ff3b30"), 1.0, 0.0, 2.0),
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
    // Where it was drawn and nowhere else, after the round trip through the file.
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

// The temporary file is the save's own business, and it is hidden, so one
// left behind is one the reader would never find and never clear. Saving
// twice over the same name is where a temporary that outlives its save, or a
// name that repeats itself, would show up.
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

/// A directory of its own for a test that touches real files, so parallel
/// tests cannot see each other's.
fn scratch_directory(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "tfolio-{label}-{:016x}",
        getrandom::u64().expect("the system should have randomness")
    ));

    fs::create_dir_all(&directory).expect("the temporary directory should be creatable");
    directory
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

    // The quad (45,40)-(155,70) at two pixels per point, as the highlight
    // placement test draws it.
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

    // The adoption has to hold: a plain save now has somewhere to go.
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

    // …while exporting *onto* the source is exactly a save, whatever the
    // button was called.
    let onto_source = engine
        .export_to(document.id, &source)
        .expect("the export should overwrite the source");
    assert!(onto_source.saved_to_source);

    fs::remove_dir_all(&directory).ok();
}

// Exporting *onto* the source is an ordinary save for a plain document — so
// it has to carry the same watermark refusal `save` makes, or the export
// dialog becomes the way around it. The reader would get no second chance:
// once their own file holds the mark and closes, this app can no longer
// lift it.
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

    // A copy elsewhere is still the one destination a watermark may reach.
    engine
        .export_to(document.id, &directory.join("copy.pdf"))
        .expect("the export should write the watermarked copy");

    fs::remove_dir_all(&directory).ok();
}

// The dialog hands back whatever path the reader navigated to, which on a
// machine with a symlinked home or `/tmp` is routinely not the spelling the
// source was opened under.
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

// Deleting an annotation leaves its resources — for a Chinese note, a whole
// font subset — in the document, and a straight save writes them all out:
// measured at 21 KB after five undo/redo rounds against 4 KB clean. The
// save path reloads to collect them, and this is the byte-count that
// proves it still does.
#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn a_save_after_deletions_collects_what_they_left_behind() {
    let engine = test_engine();

    // The baseline: the same note added once and never deleted.
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
        engine
            .delete_last_annotation(document.id, 1)
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

    // The reload the collection rides on must not surrender the undo guard:
    // the session's note is still the tail of the page's annotations…
    engine
        .delete_last_annotation(document.id, 1)
        .expect("the session's note should survive the collecting save");
    // …and past the session's own marks it still refuses.
    assert!(
        engine.delete_last_annotation(document.id, 1).is_err(),
        "the guard should still refuse the document's own annotations"
    );
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

    // Against the page's own unrotated height, not against `span.top`: both
    // directions of the flip go through `unrotated_page_height`, so a test
    // that only checked the highlight landed back where the span said would
    // pass with the flip broken in both, each error cancelling the other.
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

    engine
        .delete_last_annotation(document.id, 1)
        .expect("PDFium should remove the annotation");

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

    engine
        .delete_last_annotation(document.id, 1)
        .expect("PDFium should remove the remaining annotation");

    let error = engine
        .delete_last_annotation(document.id, 1)
        .expect_err("a page with nothing on it has nothing to undo");
    assert!(error.contains("no annotation of this session's"));
}

// The guard between a frontend that has lost count and the reader's own
// document.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn refuses_to_remove_an_annotation_it_did_not_add() {
    let engine = test_engine();
    let document = engine.open(link_pdf()).expect("PDFium should open the PDF");

    // The document arrives with one annotation of its own.
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        1
    );

    let error = engine
        .delete_last_annotation(document.id, 1)
        .expect_err("nothing of this session's is on the page yet");
    assert!(error.contains("no annotation of this session's"));

    engine
        .add_highlight(
            document.id,
            1,
            &[quad(10.0, 20.0, 80.0, 12.0)],
            "#ffd54a",
            0.4,
        )
        .expect("PDFium should create the highlight");
    engine
        .delete_last_annotation(document.id, 1)
        .expect("the session's own highlight comes back off");

    // Once its own mark is gone it stops, rather than taking the document's.
    let error = engine
        .delete_last_annotation(document.id, 1)
        .expect_err("the document's own annotation is not the session's to remove");
    assert!(error.contains("no annotation of this session's"));
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        1,
        "the document's own annotation should still be there"
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

// A border has to be drawn at the width the reader chose, and inside the box
// they dragged — where the preview's `box-sizing: border-box` draws it.
//
// A stroke is centred on its path and PDFium clips a stamp to the annotation's
// `/Rect`, so a path traced along the bounds renders at *half* width: measuring
// the run of pixels across the border is what tells the two apart. Counting
// annotations, or total ink, would not.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn draws_a_border_at_its_full_width_inside_the_bounds() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    // A 12pt black border on the box (50,50)-(150,150), no fill. At two pixels
    // per point that is px 100-300, with each border 24px wide and lying
    // *inside* that span: 100-124 on the left, 276-300 on the right.
    engine
        .add_rect(
            document.id,
            1,
            &quad(50.0, 50.0, 100.0, 100.0),
            &rect_style(Some("#000000"), None, 1.0, 0.0, 12.0),
        )
        .expect("PDFium should create the rectangle");

    // Halfway down the box, so the scanline crosses the two vertical edges.
    let runs = dark_runs_on_scanline(engine, document.id, 1, 200);

    assert_eq!(
        runs,
        vec![(100, 24), (276, 24)],
        "a 12pt border should render 24px wide inside the bounds it was dragged"
    );
}

fn text_note_style(font_size: f32) -> TextNoteStyle {
    TextNoteStyle {
        font_family: "sans".into(),
        font_size,
        color: "#000000".into(),
        opacity: 1.0,
    }
}

fn note_origin(left: f32, top: f32) -> PagePoint {
    PagePoint { left, top }
}

/// The bytes a document takes up once saved, which is how the tests below
/// tell an embedded font from a subset of one.
fn saved_size(engine: &PdfiumEngine, document_id: u64) -> u64 {
    let directory = scratch_directory("note");
    let destination = directory.join("note.pdf");

    engine
        .save_to(document_id, &destination)
        .expect("PDFium should save the document");

    let size = fs::metadata(&destination)
        .expect("the saved document should exist")
        .len();

    fs::remove_dir_all(&directory).ok();
    size
}

// Where the reader clicked is the top of the text, but PDFium draws from the
// baseline — so a note placed without correcting for that lands a whole line
// away from the click. Only the pixels can tell: the annotation's own bounds
// would report the wrong place just as confidently as the right one.
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

    // The note starts at (20,100) and one line of 24pt type is at most 24pt
    // tall, so at two pixels per point every mark belongs inside this box.
    // A baseline mistaken for the top would put the text above it.
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

    // Where it landed is only half of it — the ink has to be the *size* a
    // 24pt line is, too. Text scaled into a corner of the right box passes
    // every check above and is still the wrong picture.
    let (left, top, right, bottom) =
        ink_bounds(engine, document.id, 1).expect("the note should draw something");

    // Two pixels to the point on this fixture, so the note's own 20pt left
    // edge is 40px, give or take the first glyph's side bearing.
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

// The bug this exists for: a subset stripped of its `cmap` renders every
// string as the same row of empty boxes. Two different strings drawing the
// same ink is exactly that failure, and it passes every count-the-annotations
// check there is.
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

// The placement test above is Latin, and a Chinese note takes a different
// route to the page: a subset face rather than a standard one, and so a
// different ascent to hang the first line from. An ascent PDFium declined
// to report for a subset would land every Chinese note a line off the click
// while every Latin one stayed right.
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
fn refuses_a_font_family_it_does_not_offer_for_chinese_too() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let style = TextNoteStyle {
        font_family: "comic".into(),
        ..text_note_style(24.0)
    };

    // Chinese carries its own face and never reaches the standard fonts, so
    // the family it names went unchecked on that path.
    assert!(engine
        .add_text_note(
            document.id,
            1,
            &note_origin(20.0, 100.0),
            "\u{4f60}\u{597d}",
            &style,
        )
        .is_err());
    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        0,
        "a refused note should leave no annotation behind"
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
    // face if that is what it gets. A note's worth of glyphs is a few KB, so
    // this holds the subsetting to something no unsubset font could pass.
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

    // Between the two outcomes, not merely above the smaller: embedding
    // even the tightest possible subset of the bundled face costs ~3.4 KB
    // against ~650 bytes for a standard font, and a ceiling above both would
    // pass whether or not a font went in.
    assert!(
        growth < 2_000,
        "a Latin note grew the file by {growth} bytes, so it embedded a font \
             it had no need of"
    );
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

    let cases: Vec<(&str, Result<(), String>)> = vec![
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
            "a font family this app does not offer",
            engine.add_text_note(
                document.id,
                1,
                &origin,
                "Hi",
                &TextNoteStyle {
                    font_family: "comic".into(),
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

    // Nothing was drawn and nothing was left behind: every refusal above
    // happened before a mark reached the page, or wound one back if it had.
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

// Three pages where only the first carries an annotation — the document's own
// link. The test adds a session highlight beside it.
fn three_page_link_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [7 0 R] /Contents 6 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        "7 0 obj\n<< /Type /Annot /Subtype /Link /Rect [10 250 90 270] /Border [0 0 0] >>\nendobj\n".to_string(),
    ])
}

// Three pages and a single bookmark aimed at the third via its page object
// reference — the destination form a page move must keep resolving.
fn outlined_three_page_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        "7 0 obj\n<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>\nendobj\n".to_string(),
        "8 0 obj\n<< /Title (Chapter) /Parent 7 0 R /Dest [5 0 R /XYZ null null null] >>\nendobj\n".to_string(),
    ])
}

/// Applies `move_pages` to an open document directly, standing in for the M7
/// reorder command while proving the forked wrapper behaves.
fn move_document_pages(engine: &PdfiumEngine, document_id: u64, page_indices: &[i32], dest: i32) {
    let mut documents = engine
        .documents
        .lock()
        .expect("the document store should be usable");
    let entry = documents
        .get_mut(&document_id)
        .expect("the document should still be open");

    entry
        .document
        .pages_mut()
        .move_pages(page_indices, dest)
        .expect("PDFium should move the pages");
}

fn page_fingerprints(engine: &PdfiumEngine, document_id: u64, page_count: i32) -> Vec<Vec<u8>> {
    (1..=page_count)
        .map(|page_number| {
            engine
                .render_bitmap(
                    document_id,
                    page_number,
                    TEST_RENDER_WIDTH,
                    MAX_RENDER_WIDTH,
                )
                .expect("PDFium should render the page")
                .into_rgb8()
                .into_raw()
        })
        .collect()
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

    // A full permutation: position i shows what was page order[i] + 1.
    let order = [2, 0, 3, 1];

    move_document_pages(engine, document.id, &order, 0);

    let after = page_fingerprints(engine, document.id, 4);

    for (position, old_index) in order.iter().enumerate() {
        assert_eq!(
            after[position],
            before[*old_index as usize],
            "position {} should hold the old page {}",
            position + 1,
            old_index + 1,
        );
    }
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

    // Send the annotated first page to the back: [B, C, A].
    move_document_pages(engine, document.id, &[1, 2, 0], 0);

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
    // `/Annots` order survives the move: the document's link is still first and
    // the session's highlight still the tail, which the `added` guard counts on.
    assert!(
        (262.0..=278.0).contains(&first_top),
        "the link sat at top {first_top}",
    );
    assert!(
        (232.0..=248.0).contains(&last_top),
        "the highlight sat at top {last_top}",
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

    // Bring the bookmarked page to the front: [C, A, B].
    move_document_pages(engine, document.id, &[2, 0, 1], 0);

    let outline = {
        let documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");

        collect_bookmark_siblings(documents[&document.id].document.bookmarks().root())
    };

    assert_eq!(outline.len(), 1, "the bookmark itself should survive");
    assert_eq!(
        outline[0].page_number,
        Some(1),
        "the bookmark should resolve to the page's new position",
    );
}

// M7's blank-page insertion registers pages the watermark does not cover as
// zero-object entries. Stand in for the command by inserting a page by hand:
// the guard must accept the bare page, a replacement must cover it, and a
// removal must still lift every owned object.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_guard_accepts_a_zero_object_entry() {
    let engine = test_engine();
    let document = engine
        .open(two_page_pdf())
        .expect("PDFium should open the PDF");

    engine
        .apply_watermark(document.id, watermark_config("DRAFT"))
        .expect("PDFium should apply the watermark");

    {
        let mut documents = engine
            .documents
            .lock()
            .expect("the document store should be usable");
        let entry = documents
            .get_mut(&document.id)
            .expect("the document should still be open");
        let page = entry
            .document
            .pages_mut()
            .create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(200.0), PdfPoints::new(300.0)),
                1,
            )
            .expect("PDFium should insert the blank page");

        drop(page);

        let page_id = entry.page_ids.iter().max().copied().unwrap_or(0) + 1;

        entry.page_ids.insert(1, page_id);
        entry
            .watermark
            .as_mut()
            .expect("the watermark state should exist")
            .per_page
            .insert(
                page_id,
                WatermarkPageState {
                    base_objects: 0,
                    added_objects: 0,
                    text_identity: String::new(),
                },
            );
    }

    let objects_on = |page_number: i32| {
        with_page(engine, document.id, page_number, |page| {
            page.objects().len()
        })
    };

    assert_eq!(objects_on(1), 1, "the first page carries its mark");
    assert_eq!(objects_on(2), 0, "the inserted page is bare");
    assert_eq!(objects_on(3), 1, "the last page carries its mark");

    // A replacement re-plans over the zero-object entry and covers the page.
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
