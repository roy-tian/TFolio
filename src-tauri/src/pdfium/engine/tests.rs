use super::*;

use allsorts::{
    binary::read::ReadScope,
    font::{Font, MatchingPresentation},
    font_data::FontData,
};

use crate::pdfium::geometry::{A4_LONG_POINTS, A4_SHORT_POINTS};
use crate::pdfium::library::PDFIUM_LIBRARY_NAME;
use crate::pdfium::page_numbers::{PageNumbersMode, PageNumbersPosition};
use crate::pdfium::watermark::{WatermarkDirection, WatermarkLayout};

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

// Two pages for document search: the first occurrence crosses a visual line
// break, while the second sits on one line and differs in case.
fn wrapped_search_pdf() -> Vec<u8> {
    let first = "BT\n/F1 24 Tf\n40 250 Td\n(Wrapped) Tj\n0 -30 Td\n(phrase) Tj\nET\n";
    let second = "BT\n/F1 24 Tf\n40 200 Td\n(WRAPPED PHRASE) Tj\nET\n";
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n".to_string(),
        format!(
            "5 0 obj\n<< /Length {} >>\nstream\n{first}endstream\nendobj\n",
            first.len()
        ),
        format!(
            "6 0 obj\n<< /Length {} >>\nstream\n{second}endstream\nendobj\n",
            second.len()
        ),
        "7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
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

/// The one engine every test shares, mirroring the app's single `PdfiumState`:
/// parallel tests through separate engine locks would corrupt the heap.
fn test_engine() -> &'static PdfiumEngine {
    static ENGINE: std::sync::OnceLock<PdfiumEngine> = std::sync::OnceLock::new();

    ENGINE.get_or_init(|| PdfiumEngine {
        word: crate::convert::WordConverter::nowhere(),
        pdfium: test_pdfium(),
        documents: Mutex::new(HashMap::new()),
        next_document_id: AtomicU64::new(1),
        // Straight from the source tree: the tests have no `AppHandle` to
        // resolve an app-data path through, and no business fetching a font.
        fallback_font_candidates: vec![crate::pdfium::font::bundled_font_path(
            crate::pdfium::font::CJK_FONT_NAME,
        )],
        fallback_font: OnceLock::new(),
        // Seeded, not resolved: assertions pin to the source tree's face rather
        // than whichever sans the machine has; the resolved branch is `font_engine`'s.
        system_face: OnceLock::from(None),
        // Resolved from the system's own fonts on the first apply, exactly as
        // the app resolves it.
        page_number_font: OnceLock::new(),
        approved_paths: Mutex::new(HashSet::new()),
        operations: Mutex::new(HashMap::new()),
        next_operation_id: AtomicU64::new(1),
    })
}

fn last_mark(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> Option<u64> {
    let documents = engine
        .documents
        .lock()
        .expect("the document store should be usable");
    let page_id = documents[&document_id]
        .page_id(page_number)
        .expect("the document should have the page");

    documents[&document_id]
        .marks
        .get(&page_id)
        .and_then(|marks| marks.last().copied())
}

/// Undo's backend: take the last mark this session made on a page back off.
/// The document's own annotations have no ids, so undo can never reach them.
fn delete_last_mark(
    engine: &PdfiumEngine,
    document_id: u64,
    page_number: i32,
) -> Result<Vec<i32>, String> {
    let mark_id = last_mark(engine, document_id, page_number)
        .ok_or_else(|| format!("page {page_number} has no mark of this session's"))?;

    engine.delete_marks(document_id, &[mark_id])
}

/// Hands `inspect` a page with the store locked: loading and dropping one is
/// PDFium work like any other, and nothing here may reach PDFium unlocked.
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
    // Bounds are unrotated, top-left origin: the flip uses the unrotated
    // height (300), not the displayed 200 — which would go negative.
    assert!((50.0..55.0).contains(&span.left), "left was {}", span.left);
    assert!((30.0..36.0).contains(&span.top), "top was {}", span.top);
    assert!(span.width > 0.0 && span.top > 0.0);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn extracts_plain_page_text_with_its_line_breaks() {
    let engine = test_engine();
    let document = engine
        .open(wrapped_search_pdf())
        .expect("PDFium should open the search fixture");

    let first = engine
        .extract_plain_text(document.id, 1)
        .expect("PDFium should extract the page's text");
    let lines: Vec<&str> = first
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    // The two runs sit on lines of their own, and a copy has to keep them
    // apart: the positioned spans the text layer is built from carry no breaks.
    assert_eq!(lines, ["Wrapped", "phrase"], "got {first:?}");

    let second = engine
        .extract_plain_text(document.id, 2)
        .expect("PDFium should extract the second page's text");
    assert_eq!(second.trim(), "WRAPPED PHRASE");

    assert!(
        engine.extract_plain_text(document.id, 3).is_err(),
        "a page past the end names nothing to extract"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn searches_only_page_text_across_visual_line_breaks() {
    let engine = test_engine();
    let document = engine
        .open(wrapped_search_pdf())
        .expect("PDFium should open the search fixture");
    let outcome = engine
        .search_text(document.id, "  wrapped\nphrase  ")
        .expect("PDFium should search the whole document");

    assert!(!outcome.cancelled);
    assert!(!outcome.limit_reached);
    assert_eq!(outcome.matches.len(), 2);
    assert_eq!(outcome.matches[0].page_number, 1);
    assert_eq!(
        outcome.matches[0].rects.len(),
        2,
        "the wrapped occurrence should keep one highlight rectangle per line"
    );
    assert_eq!(outcome.matches[1].page_number, 2);
    assert_eq!(outcome.matches[1].rects.len(), 1);
    assert!(outcome
        .matches
        .iter()
        .flat_map(|result| &result.rects)
        .all(|rect| rect.width > 0.0 && rect.height > 0.0));

    engine
        .close(document.id)
        .expect("the search fixture should close");
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
        width_ratio: 0.8,
        direction: WatermarkDirection::Ascending,
        layout: WatermarkLayout::Single,
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

fn rect_style(color: &str, opacity: f32) -> RectStyle {
    RectStyle {
        color: color.to_string(),
        opacity,
    }
}

fn rect_effect(kind: RectEffectKind, strength: f32) -> RectEffect {
    RectEffect { kind, strength }
}

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

// Real ink for a highlight to sit over, drawn at an upright (50, 250) baseline.
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

// Dense bars inside (40,70)-(160,170): a high-frequency signal for mosaic and
// blur to reduce, with the untouched margin catching an effect placed wide.
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

// Four asymmetric colour fields: without them the target band alone cannot
// distinguish the two quarter-turn counter-rotations.
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

/// Ink off the pixels, not the annotation list — one PDFium stored but will
/// not draw counts as working. Split by region: misplaced ink totals the same.
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

    delete_last_mark(engine, document.id, 1).expect("PDFium should remove the mosaic");
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

fn rendered_darkness(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> u64 {
    let (inside, outside) = ink_inside_and_outside(engine, document_id, page_number, (0, 0, 0, 0));

    inside + outside
}

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

fn text_note_style(font_size: f32) -> TextNoteStyle {
    TextNoteStyle {
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

/// An engine seeded with what the app would have resolved. Safe beside the
/// shared one: nothing reached from here touches PDFium or its serialising lock.
fn font_engine(system_face: Option<(Vec<u8>, usize)>, fallback: Vec<PathBuf>) -> PdfiumEngine {
    PdfiumEngine {
        word: crate::convert::WordConverter::at_directory(std::env::temp_dir()),
        pdfium: test_pdfium(),
        documents: Mutex::new(HashMap::new()),
        next_document_id: AtomicU64::new(1),
        fallback_font_candidates: fallback,
        fallback_font: OnceLock::new(),
        system_face: OnceLock::from(system_face),
        page_number_font: OnceLock::new(),
        approved_paths: Mutex::new(HashSet::new()),
        operations: Mutex::new(HashMap::new()),
        next_operation_id: AtomicU64::new(1),
    }
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

/// Whether `subset` can draw every character of `text` — the question a note
/// that reached the page as a row of empty boxes answers with `false`.
fn draws(subset: &[u8], text: &str) -> bool {
    let font_data = ReadScope::new(subset)
        .read::<FontData<'_>>()
        .expect("read the subset");
    let mut font = Font::new(
        font_data
            .table_provider(0)
            .expect("read the subset's tables"),
    )
    .expect("parse the subset");

    text.chars().all(|character| {
        font.lookup_glyph_index(character, MatchingPresentation::NotRequired, None)
            .0
            != 0
    })
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

// One page per offset, each with its bar at that x: distinct fingerprints let
// a merge test say which document's page now sits where.
fn banded_pdf(offsets: &[i32]) -> Vec<u8> {
    let count = offsets.len();
    let kids = (0..count)
        .map(|index| format!("{} 0 R", 3 + index))
        .collect::<Vec<_>>()
        .join(" ");
    let mut objects = vec![
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        format!("2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {count} >>\nendobj\n"),
    ];

    for index in 0..count {
        objects.push(format!(
            "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents {} 0 R >>\nendobj\n",
            3 + index,
            3 + count + index,
        ));
    }

    for (index, offset) in offsets.iter().enumerate() {
        let content = format!("0 0 0 rg\n{offset} 100 30 120 re f\n");

        objects.push(format!(
            "{} 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            3 + count + index,
            content.len(),
        ));
    }

    build_pdf(&objects)
}

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
    assert!(error.contains("exported as a copy"), "why: {error}");
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

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn creates_a_blank_a4_document_with_no_file_of_its_own() {
    let engine = test_engine();
    let document = engine
        .create_blank()
        .expect("PDFium should create a blank document");

    assert_eq!(document.num_pages, 1);

    let page = &document.pages[0];
    assert!(
        (page.width - 595.0).abs() < 1.0 && (page.height - 842.0).abs() < 1.0,
        "the page should be A4, and was {}x{}",
        page.width,
        page.height
    );
    // Nothing to overwrite: the document never came from a file, so the save
    // key stays down until an export gives it one.
    assert!(document.path.is_none());

    engine
        .close(document.id)
        .expect("the new document should close");
}

// A 400x500 single page, so a blank measured from the file it precedes can be
// told from one measured from the file before it (200x300 everywhere else).
fn wide_single_page_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents 4 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
    ])
}

/// One square annotation and one link — the two kinds a merge source brings,
/// and what tells an import that keeps them apart from one that does not.
fn annotated_pdf() -> Vec<u8> {
    let content = "0 0 0 rg\n20 100 30 120 re f\n".to_string();
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R /Annots [5 0 R 6 0 R] >>\nendobj\n"
            .to_string(),
        format!(
            "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            content.len()
        ),
        "5 0 obj\n<< /Type /Annot /Subtype /Square /Rect [20 100 50 220] /F 4 /C [1 0 0] >>\nendobj\n"
            .to_string(),
        "6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [20 20 180 40] /Border [0 0 0] /A << /Type /Action /S /URI /URI (https://example.com) >> >>\nendobj\n"
            .to_string(),
    ];

    build_pdf(&objects)
}

/// A single landscape page, 700x500, with a black bar in its lower left — wider
/// than A4 upright, so normalizing it has to turn the sheet on its side.
fn landscape_banded_pdf() -> Vec<u8> {
    let content = "0 0 0 rg\n40 60 120 80 re f\n".to_string();
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 500] /Contents 4 0 R >>\nendobj\n"
            .to_string(),
        format!(
            "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            content.len()
        ),
    ];

    build_pdf(&objects)
}

/// The smallest box around every non-white pixel, as fractions of the render:
/// fractions let an A4 sheet and the page it carries be compared directly.
fn rendered_ink_box(image: &image::RgbImage) -> (f32, f32, f32, f32) {
    let mut left = u32::MAX;
    let mut top = u32::MAX;
    let mut right = 0u32;
    let mut bottom = 0u32;

    for (x, y, pixel) in image.enumerate_pixels() {
        // Anti-aliasing leaves a grey fringe around the bar; only ink well clear
        // of the ground counts, so the box is the mark rather than its halo.
        if pixel.0.iter().all(|channel| *channel > 200) {
            continue;
        }

        left = left.min(x);
        top = top.min(y);
        right = right.max(x + 1);
        bottom = bottom.max(y + 1);
    }

    assert!(left < right && top < bottom, "the page should carry ink");

    let width = image.width() as f32;
    let height = image.height() as f32;

    (
        left as f32 / width,
        top as f32 / height,
        right as f32 / width,
        bottom as f32 / height,
    )
}

/// Held for the length of every merge test: `OperationTarget::Merge` names no
/// document, so a stop in one test would cancel a merge another test just started.
fn merge_test_guard() -> MutexGuard<'static, ()> {
    static GUARD: Mutex<()> = Mutex::new(());

    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn merge_sources(directory: &Path, files: &[(&str, Vec<u8>)]) -> Vec<PathBuf> {
    files
        .iter()
        .map(|(stem, bytes)| {
            let path = directory.join(format!("{stem}.pdf"));

            fs::write(&path, bytes).expect("the source should write to disk");
            path
        })
        .collect()
}

#[test]
fn a_merged_bookmark_title_is_the_file_name_without_its_extension() {
    assert_eq!(
        bookmark_title(Path::new("/tmp/Chapter One.pdf")),
        "Chapter One"
    );
    assert_eq!(bookmark_title(Path::new("report.PDF")), "report");
    // A path that ends in no name of its own still has to say something.
    assert_eq!(bookmark_title(Path::new("/")), "/");
}

#[test]
fn a_kept_outline_moves_onto_the_pages_its_file_landed_on() {
    let items = vec![PdfOutlineItem {
        title: "Chapter".into(),
        page_number: Some(2),
        items: vec![PdfOutlineItem {
            title: "Section".into(),
            page_number: Some(3),
            items: Vec::new(),
        }],
    }];

    let nodes = remapped_outline(items, 4);

    assert_eq!(nodes.len(), 1);
    assert_eq!(
        nodes[0].page, 5,
        "the file's page 2 is the document's page 6"
    );
    assert_eq!(nodes[0].children[0].page, 6);
}

#[test]
fn a_bookmark_with_no_destination_falls_back_to_its_own_file() {
    let items = vec![PdfOutlineItem {
        title: "Unplaced".into(),
        page_number: None,
        items: Vec::new(),
    }];

    assert_eq!(remapped_outline(items, 7)[0].page, 7);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_appends_every_file_in_order() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-order");
    let first = banded_pdf(&[20, 60]);
    let second = banded_pdf(&[110, 150, 190]);
    let paths = merge_sources(
        &directory,
        &[("first", first.clone()), ("second", second.clone())],
    );

    // Each source rendered on its own, so the comparison is independent of the
    // merge under test rather than fed back from it.
    let first_prints = {
        let opened = engine
            .open(first)
            .expect("PDFium should open the first file");

        page_fingerprints(engine, opened.id, 2)
    };
    let second_prints = {
        let opened = engine
            .open(second)
            .expect("PDFium should open the second file");

        page_fingerprints(engine, opened.id, 3)
    };

    let mut progress = Vec::new();
    let merged = engine
        .merge_files_with_progress(
            paths,
            false,
            false,
            MergeBookmarks::None,
            false,
            |completed, total| progress.push((completed, total)),
        )
        .expect("PDFium should merge the files")
        .expect("a merge nobody stopped hands back its document");

    assert_eq!(progress, [(0, 5), (1, 5), (2, 5), (3, 5), (4, 5), (5, 5)]);
    assert_eq!(merged.num_pages, 5);
    assert!(
        merged.path.is_none(),
        "a merged document has no file to be saved back over"
    );
    assert!(merged.outline.is_empty(), "no bookmarks were asked for");

    let prints = page_fingerprints(engine, merged.id, 5);

    assert_eq!(&prints[..2], &first_prints[..]);
    assert_eq!(&prints[2..], &second_prints[..]);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_stopped_merge_hands_back_nothing() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-stopped");
    let paths = merge_sources(
        &directory,
        &[
            ("first", banded_pdf(&[20, 60])),
            ("second", banded_pdf(&[110, 150])),
            ("third", banded_pdf(&[30, 90])),
        ],
    );
    // Stopped from the run's own progress, where the reader's cancel lands:
    // while the merge holds the document lock.
    let merged = engine
        .merge_files_with_progress(
            paths,
            false,
            false,
            MergeBookmarks::None,
            false,
            |completed, _| {
                if completed > 0 {
                    engine.cancel_operation(OperationTarget::Merge);
                }
            },
        )
        .expect("a stopped merge is not a failure");

    // No store check follows: a stopped merge never reaches the store's open,
    // and the shared engine's size is not this test's to read.
    assert!(merged.is_none(), "a stopped merge produces no document");
    assert!(
        !engine.cancel_operation(OperationTarget::Merge),
        "the merge is off the list once it has returned"
    );

    fs::remove_dir_all(directory).ok();
}

fn image_source(directory: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let path = directory.join(name);
    let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([20, 40, 160]),
    ));

    image
        .save_with_format(&path, ImageFormat::Png)
        .expect("the image should write to disk");
    path
}

/// A JPEG carrying EXIF orientation 6 — what a phone records instead of
/// rotating its pixels — built by hand because the `image` crate writes no EXIF.
fn rotated_image_source(directory: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let mut jpeg = Cursor::new(Vec::new());

    DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([20, 40, 160]),
    ))
    .write_to(&mut jpeg, ImageFormat::Jpeg)
    .expect("the fixture should encode");

    let jpeg = jpeg.into_inner();
    let mut exif = b"Exif\0\0".to_vec();

    // Little-endian TIFF header, IFD0 at offset 8.
    exif.extend_from_slice(b"II\x2a\x00\x08\x00\x00\x00");
    // One entry: tag 0x0112 (Orientation), SHORT, count 1, value 6.
    exif.extend_from_slice(b"\x01\x00");
    exif.extend_from_slice(b"\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00");
    // No IFD after this one.
    exif.extend_from_slice(b"\x00\x00\x00\x00");

    let mut bytes = jpeg[..2].to_vec();
    let segment_length = (exif.len() + 2) as u16;

    bytes.extend_from_slice(b"\xff\xe1");
    bytes.extend_from_slice(&segment_length.to_be_bytes());
    bytes.extend_from_slice(&exif);
    bytes.extend_from_slice(&jpeg[2..]);

    let path = directory.join(name);

    fs::write(&path, bytes).expect("the image should write to disk");
    path
}

fn archive_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let file = fs::File::open(path).expect("the archive should be readable");
    let mut archive = zip::ZipArchive::new(file).expect("the archive should be a zip");

    (0..archive.len())
        .map(|index| {
            let mut entry = archive.by_index(index).expect("the entry should be listed");
            let name = entry.name().to_string();
            let mut bytes = Vec::new();

            std::io::Read::read_to_end(&mut entry, &mut bytes)
                .expect("the entry should be readable");
            (name, bytes)
        })
        .collect()
}

#[test]
fn an_archive_entry_is_named_after_its_file_and_never_repeats() {
    let mut used = HashSet::new();

    assert_eq!(
        archive_pdf_name(Path::new("/tmp/report.pdf"), &mut used),
        "report.pdf"
    );
    // A photo comes out as the page it was laid on, so it keeps its stem alone.
    assert_eq!(
        archive_pdf_name(Path::new("/tmp/scan.JPG"), &mut used),
        "scan.pdf"
    );
    assert_eq!(
        archive_pdf_name(Path::new("/elsewhere/report.pdf"), &mut used),
        "report (2).pdf"
    );
    assert_eq!(
        archive_pdf_name(Path::new("/third/report.pdf"), &mut used),
        "report (3).pdf"
    );
    // A path that ends in no name of its own still has to say something.
    assert_eq!(archive_pdf_name(Path::new("/"), &mut used), "document.pdf");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_merge_lays_an_image_on_a_sheet_of_its_own() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-image");
    let pdf = directory.join("first.pdf");

    fs::write(&pdf, banded_pdf(&[20])).expect("the source should write to disk");

    let wide = image_source(&directory, "wide.png", 1600, 900);
    let tall = image_source(&directory, "tall.jpg", 900, 1600);

    // Each image is read the way the merge will read it, so the row the wizard
    // shows and the pages it gets cannot disagree.
    let summaries = engine
        .inspect_files(vec![pdf.clone(), wide.clone(), tall.clone()], false)
        .expect("the files should inspect");

    assert!(matches!(summaries[0].kind, MergeSourceKind::Pdf));
    assert!(matches!(summaries[1].kind, MergeSourceKind::Image));
    assert_eq!(summaries[1].page_count, Some(1));
    assert!(!summaries[1].has_outline);

    let merged = engine
        .merge_files(vec![pdf, wide, tall], false, MergeBookmarks::None)
        .expect("PDFium should merge the image in");

    assert_eq!(merged.num_pages, 3);

    // An image has no page size of its own, so it is always fitted to a sheet —
    // turned the way the image is, whatever the merge's own A4 option says.
    let landscape = &merged.pages[1];

    assert!(
        (landscape.width - A4_LONG_POINTS).abs() < 1.0,
        "{landscape:?}"
    );
    assert!(
        (landscape.height - A4_SHORT_POINTS).abs() < 1.0,
        "{landscape:?}"
    );

    let portrait = &merged.pages[2];

    assert!(
        (portrait.width - A4_SHORT_POINTS).abs() < 1.0,
        "{portrait:?}"
    );
    assert!(
        (portrait.height - A4_LONG_POINTS).abs() < 1.0,
        "{portrait:?}"
    );

    // The image really landed: a blank sheet would carry no ink at all.
    let (left, top, right, bottom) = rendered_ink_box(
        &engine
            .render_bitmap(merged.id, 2, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
            .expect("PDFium should render the image's sheet")
            .into_rgb8(),
    );

    assert!(
        left < 0.01 && right > 0.99,
        "the image should fill the width"
    );
    assert!(
        top > 0.05 && bottom < 0.95,
        "the image should be letterboxed"
    );

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_image_is_laid_the_way_its_metadata_says_it_was_held() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-image-orientation");
    let pdf = directory.join("first.pdf");

    fs::write(&pdf, banded_pdf(&[20])).expect("the source should write to disk");

    // Stored 1600x900 — landscape pixels — but recorded as a quarter turn from
    // upright, which is how a phone stores a portrait photograph.
    let upright = rotated_image_source(&directory, "portrait.jpg", 1600, 900);
    let merged = engine
        .merge_files(vec![pdf, upright], false, MergeBookmarks::None)
        .expect("PDFium should merge the image in");
    let sheet = &merged.pages[1];

    assert!(
        (sheet.width - A4_SHORT_POINTS).abs() < 1.0,
        "the sheet should stand upright, not follow the stored pixels: {sheet:?}"
    );
    assert!((sheet.height - A4_LONG_POINTS).abs() < 1.0, "{sheet:?}");

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_file_that_is_no_image_is_reported_unusable_rather_than_dropped() {
    let engine = test_engine();
    let directory = scratch_directory("merge-bad-image");
    let path = directory.join("broken.png");

    fs::write(&path, b"not a PNG at all").expect("the file should write to disk");

    let summaries = engine
        .inspect_files(vec![path.clone()], false)
        .expect("the inspection should still answer");

    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].page_count, None);
    assert!(matches!(summaries[0].kind, MergeSourceKind::Image));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_merge_exported_as_images_holds_one_png_per_page() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-png-zip");
    let paths = merge_sources(
        &directory,
        &[
            ("first", banded_pdf(&[20, 60])),
            ("second", banded_pdf(&[110])),
        ],
    );
    let merged = engine
        .merge_files(paths, false, MergeBookmarks::None)
        .expect("PDFium should merge the files");
    let archive = directory.join("pages.zip");

    let mut progress = Vec::new();
    let written = engine
        .export_page_images(merged.id, &archive, |completed, total| {
            progress.push((completed, total))
        })
        .expect("the pages should export");

    assert!(written);
    assert_eq!(progress.last(), Some(&(3, 3)));

    let entries = archive_entries(&archive);

    assert_eq!(
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["page-1.png", "page-2.png", "page-3.png"]
    );

    for (name, bytes) in &entries {
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{name} should be a PNG");
    }

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermarked_copies_are_written_one_per_source() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-watermark-zip");
    let paths = merge_sources(
        &directory,
        &[("first", banded_pdf(&[20])), ("second", banded_pdf(&[110]))],
    );
    let archive = directory.join("marked.zip");
    let watermark = watermark_config("DRAFT");

    let written = engine
        .export_watermarked_copies(
            paths.clone(),
            true,
            Some(watermark),
            false,
            &archive,
            |_, _| {},
        )
        .expect("the copies should export");

    assert!(written);

    let entries = archive_entries(&archive);

    assert_eq!(
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["first.pdf", "second.pdf"]
    );

    for (name, bytes) in &entries {
        assert_eq!(&bytes[..5], b"%PDF-", "{name} should be a PDF");

        let opened = engine
            .open(bytes.clone())
            .expect("the copy should open as a PDF");

        assert_eq!(opened.num_pages, 1);
        assert!((opened.pages[0].width - A4_SHORT_POINTS).abs() < 1.0);
        assert!(
            opened.path.is_none(),
            "a copy has no source to be written to"
        );

        engine.close(opened.id).expect("the copy should close");
    }

    for path in &paths {
        assert_eq!(
            fs::read(path).expect("the source should still be readable")[..5],
            *b"%PDF-"
        );
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_watermark_export_refuses_to_replace_one_of_its_own_sources() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-watermark-onto-source");
    let paths = merge_sources(
        &directory,
        &[("first", banded_pdf(&[20])), ("second", banded_pdf(&[110]))],
    );
    let destination = paths[1].clone();

    let refused = engine
        .export_watermarked_copies(paths.clone(), false, None, false, &destination, |_, _| {})
        .expect_err("an archive must not land on a file it reads");

    assert!(refused.contains("built from"), "{refused}");
    assert_eq!(
        fs::read(&destination).expect("the source should still be readable"),
        banded_pdf(&[110])
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_normalized_merge_sizes_every_sheet_a4() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-a4-sizes");
    let paths = merge_sources(
        &directory,
        &[
            ("upright", banded_pdf(&[20, 60])),
            ("sideways", landscape_banded_pdf()),
        ],
    );

    let merged = engine
        .merge_files_onto_a4(paths, false)
        .expect("PDFium should merge onto A4");

    assert_eq!(merged.num_pages, 3);

    // The two 200x300 pages already fit upright and keep that orientation; the
    // 700x500 one is wider than A4 stands, so its sheet lies down.
    for page in &merged.pages[..2] {
        assert!((page.width - A4_SHORT_POINTS).abs() < 1.0, "{page:?}");
        assert!((page.height - A4_LONG_POINTS).abs() < 1.0, "{page:?}");
    }

    let sideways = &merged.pages[2];

    assert!(
        (sideways.width - A4_LONG_POINTS).abs() < 1.0,
        "{sideways:?}"
    );
    assert!(
        (sideways.height - A4_SHORT_POINTS).abs() < 1.0,
        "{sideways:?}"
    );

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_normalized_page_leaves_its_source_s_annotations_behind() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-a4-annotations");
    let source = annotated_pdf();
    let paths = merge_sources(
        &directory,
        &[("first", source.clone()), ("second", source.clone())],
    );

    let plain = engine
        .merge_files(paths.clone(), false, MergeBookmarks::None)
        .expect("PDFium should merge the files");

    assert_eq!(
        with_page(engine, plain.id, 1, |page| page.annotations().len()),
        2
    );

    engine.close(plain.id).expect("the merge should close");

    // Fitting to A4 routes content through a form XObject, which carries no
    // annotations — what `mergeWizard.normalizeA4Warning` tells the reader.
    let fitted = engine
        .merge_files_onto_a4(paths, false)
        .expect("PDFium should merge onto A4");

    assert_eq!(
        with_page(engine, fitted.id, 1, |page| page.annotations().len()),
        0,
        "an A4 sheet carries the page's content alone"
    );
    // The ink itself still arrives, so this is a loss of annotations rather
    // than of the page.
    let (left, _, right, _) = rendered_ink_box(&rendered_rgb(engine, fitted.id));

    assert!(left < right, "the page's own content should still be drawn");

    engine.close(fitted.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_normalized_page_keeps_its_own_size_in_the_middle_of_the_sheet() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-a4-centre");
    let source = banded_pdf(&[20]);
    let paths = merge_sources(
        &directory,
        &[("first", source.clone()), ("second", source.clone())],
    );

    let alone = engine.open(source).expect("PDFium should open the source");
    let (left, top, right, bottom) = rendered_ink_box(&rendered_rgb(engine, alone.id));

    engine.close(alone.id).expect("the source should close");

    let merged = engine
        .merge_files_onto_a4(paths, false)
        .expect("PDFium should merge onto A4");
    let sheet = rendered_ink_box(&rendered_rgb(engine, merged.id));

    // The bar keeps its point size — a smaller fraction of the larger sheet,
    // offset by the centring margin — computed from placement, not the render.
    let scale_x = 200.0 / A4_SHORT_POINTS;
    let scale_y = 300.0 / A4_LONG_POINTS;
    let margin_x = (1.0 - scale_x) / 2.0;
    let margin_y = (1.0 - scale_y) / 2.0;
    let expected = (
        margin_x + left * scale_x,
        margin_y + top * scale_y,
        margin_x + right * scale_x,
        margin_y + bottom * scale_y,
    );

    for (found, want) in [
        (sheet.0, expected.0),
        (sheet.1, expected.1),
        (sheet.2, expected.2),
        (sheet.3, expected.3),
    ] {
        assert!(
            (found - want).abs() < 0.01,
            "the bar should land at {want}, not {found} (whole box {sheet:?})"
        );
    }

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_normalized_merge_carries_a_rotated_page_the_way_it_reads() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-a4-rotation");
    let source = rotated_text_pdf();
    let paths = merge_sources(
        &directory,
        &[("first", source.clone()), ("second", source.clone())],
    );

    // `/Rotate 90` makes the page read 300x200, and that is the shape the sheet
    // carries — the rotation cannot survive, since the sheet has one of its own.
    let alone = engine.open(source).expect("PDFium should open the source");
    let (left, top, right, bottom) = rendered_ink_box(&rendered_rgb(engine, alone.id));

    engine.close(alone.id).expect("the source should close");

    let merged = engine
        .merge_files_onto_a4(paths, false)
        .expect("PDFium should merge onto A4");
    let sheet = rendered_ink_box(&rendered_rgb(engine, merged.id));
    let scale_x = 300.0 / A4_SHORT_POINTS;
    let scale_y = 200.0 / A4_LONG_POINTS;
    let margin_x = (1.0 - scale_x) / 2.0;
    let margin_y = (1.0 - scale_y) / 2.0;
    let expected = (
        margin_x + left * scale_x,
        margin_y + top * scale_y,
        margin_x + right * scale_x,
        margin_y + bottom * scale_y,
    );

    for (found, want) in [
        (sheet.0, expected.0),
        (sheet.1, expected.1),
        (sheet.2, expected.2),
        (sheet.3, expected.3),
    ] {
        assert!(
            (found - want).abs() < 0.02,
            "the rotated text should land at {want}, not {found} (whole box {sheet:?})"
        );
    }

    engine.close(merged.id).expect("the merge should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_pads_only_the_files_that_would_open_on_an_even_page() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-parity");
    let paths = merge_sources(
        &directory,
        &[
            ("one", minimal_pdf()),
            ("wide", wide_single_page_pdf()),
            ("two", two_page_pdf()),
        ],
    );

    let padded = engine
        .merge_files(paths.clone(), true, MergeBookmarks::None)
        .expect("PDFium should merge the files");

    // One page, a pad, the wide page, the two-page file: that file already
    // opens on page 4 — even — so it gets a pad too, surplus as that may read.
    assert_eq!(padded.num_pages, 6);
    assert_eq!(
        (padded.pages[1].width, padded.pages[1].height),
        (400.0, 500.0),
        "a pad is sized like the file it precedes, not the one before it"
    );

    let plain = engine
        .merge_files(paths, false, MergeBookmarks::None)
        .expect("PDFium should merge the files");

    assert_eq!(plain.num_pages, 4, "no pads without the option");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_writes_one_bookmark_per_file() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-per-file");
    let paths = merge_sources(
        &directory,
        &[("Front matter", two_page_pdf()), ("Body", minimal_pdf())],
    );

    let merged = engine
        .merge_files(paths, false, MergeBookmarks::PerFile)
        .expect("PDFium should merge the files");

    assert_eq!(merged.outline.len(), 2);
    assert_eq!(merged.outline[0].title, "Front matter");
    assert_eq!(merged.outline[0].page_number, Some(1));
    assert!(merged.outline[0].items.is_empty());
    assert_eq!(merged.outline[1].title, "Body");
    assert_eq!(
        merged.outline[1].page_number,
        Some(3),
        "the second file's bookmark points at the page it landed on"
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_keeps_each_source_outline_at_its_merged_position() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-keep");
    let paths = merge_sources(
        &directory,
        &[
            ("plain", two_page_pdf()),
            ("outlined", outlined_three_page_pdf()),
        ],
    );

    let merged = engine
        .merge_files(paths, false, MergeBookmarks::KeepExisting)
        .expect("PDFium should merge the files");

    // The first file brings none; the second's one bookmark aims at its own
    // third page, which is the merged document's fifth.
    assert_eq!(merged.outline.len(), 1);
    assert_eq!(merged.outline[0].title, "Chapter");
    assert_eq!(merged.outline[0].page_number, Some(5));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_nests_a_source_outline_under_its_own_file() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-nested");
    let paths = merge_sources(
        &directory,
        &[
            ("plain", two_page_pdf()),
            ("outlined", outlined_three_page_pdf()),
        ],
    );

    let merged = engine
        .merge_files(paths, false, MergeBookmarks::PerFileWithExisting)
        .expect("PDFium should merge the files");

    assert_eq!(merged.outline.len(), 2);
    assert_eq!(merged.outline[0].title, "plain");
    assert!(
        merged.outline[0].items.is_empty(),
        "a file with no bookmarks of its own gets no children"
    );
    assert_eq!(merged.outline[1].title, "outlined");
    assert_eq!(merged.outline[1].page_number, Some(3));
    assert_eq!(merged.outline[1].items.len(), 1);
    assert_eq!(merged.outline[1].items[0].title, "Chapter");
    assert_eq!(merged.outline[1].items[0].page_number, Some(5));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn merge_files_refuses_a_run_of_fewer_than_two_files() {
    let engine = test_engine();
    let directory = scratch_directory("merge-files-single");
    let paths = merge_sources(&directory, &[("only", minimal_pdf())]);

    let error = engine
        .merge_files(paths, false, MergeBookmarks::None)
        .expect_err("one file is not a merge");

    assert!(error.contains("at least two"), "{error}");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inspecting_files_reports_page_counts_and_leaves_unreadable_ones_in_place() {
    let engine = test_engine();
    let directory = scratch_directory("merge-files-inspect");
    let paths = merge_sources(
        &directory,
        &[
            ("plain", two_page_pdf()),
            ("outlined", outlined_three_page_pdf()),
            ("broken", b"not a pdf at all".to_vec()),
        ],
    );

    let summaries = engine
        .inspect_files(paths.clone(), false)
        .expect("the sweep should not fail over one bad file");

    assert_eq!(summaries.len(), 3, "every row the reader added stays");
    assert_eq!(summaries[0].page_count, Some(2));
    assert!(!summaries[0].has_outline);
    assert_eq!(summaries[1].page_count, Some(3));
    assert!(summaries[1].has_outline);
    assert_eq!(
        summaries[2].page_count, None,
        "a file PDFium cannot read is reported as unusable"
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn writing_the_outline_leaves_the_pages_as_pdfium_saved_them() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-files-roundtrip");
    let first = banded_pdf(&[20, 60]);
    let second = banded_pdf(&[110, 150, 190]);
    let paths = merge_sources(
        &directory,
        &[("first", first.clone()), ("second", second.clone())],
    );

    // Only a bookmarked run is reparsed and rewritten by lopdf, so comparing
    // it with a plain merge is what says that pass changes nothing visible.
    let plain = engine
        .merge_files(paths.clone(), false, MergeBookmarks::None)
        .expect("PDFium should merge the files");
    let bookmarked = engine
        .merge_files(paths, false, MergeBookmarks::PerFile)
        .expect("PDFium should merge the files");

    assert_eq!(bookmarked.num_pages, plain.num_pages);
    assert_eq!(
        page_fingerprints(engine, bookmarked.id, bookmarked.num_pages),
        page_fingerprints(engine, plain.id, plain.num_pages),
        "the outline pass leaves every page rendering exactly as it did"
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_word_document_that_cannot_convert_is_its_own_kind_of_unreadable() {
    let engine = test_engine();
    let directory = scratch_directory("inspect-word");
    let pdf = directory.join("plain.pdf");

    fs::write(&pdf, banded_pdf(&[20])).expect("the source should write to disk");

    let word = directory.join("letter.docx");

    fs::write(&word, b"not a document at all").expect("the source should write to disk");

    let summaries = engine
        .inspect_files(vec![pdf, word.clone()], true)
        .expect("the files should inspect");

    assert!(matches!(summaries[0].kind, MergeSourceKind::Pdf));
    assert_eq!(summaries[0].page_count, Some(1));
    // The Word row keeps its kind and says which failure it carries, rather
    // than passing as an ordinary unreadable PDF.
    assert!(matches!(summaries[1].kind, MergeSourceKind::Word));
    assert_eq!(summaries[1].page_count, None);
    assert!(matches!(
        summaries[1].error,
        Some(MergeSourceError::ConversionFailed)
    ));

    // With the conversions off, the same file is unreadable the plain way —
    // the behaviour a reader who turned the setting off has chosen.
    let off = engine
        .inspect_files(vec![word], false)
        .expect("the file should still inspect");

    assert!(matches!(off[0].kind, MergeSourceKind::Pdf));
    assert_eq!(off[0].page_count, None);
    assert!(off[0].error.is_none());
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_merge_refuses_a_word_document_that_cannot_be_converted() {
    let _merges = merge_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("merge-word");
    let pdf = directory.join("plain.pdf");

    fs::write(&pdf, banded_pdf(&[20])).expect("the source should write to disk");

    let word = directory.join("letter.docx");

    fs::write(&word, b"not a document at all").expect("the source should write to disk");

    let mut progress = Vec::new();
    let error = engine
        .merge_files_with_progress(
            vec![word, pdf],
            false,
            false,
            MergeBookmarks::None,
            true,
            |completed, total| progress.push((completed, total)),
        )
        .expect_err("the conversion refusal should fail the merge");

    assert!(error.contains("could not be converted"), "{error}");

    // The estimate promised one conversion; the refusal reconciles the bar
    // back to what the run will really do.
    assert_eq!(progress, vec![(0, 6), (0, 5)]);
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn the_copies_export_refuses_a_word_document_that_cannot_be_converted() {
    let engine = test_engine();
    let directory = scratch_directory("copies-word");
    let word = directory.join("letter.docx");

    fs::write(&word, b"not a document at all").expect("the source should write to disk");

    let archive = directory.join("copies.zip");
    let mut progress = Vec::new();
    let error = engine
        .export_watermarked_copies(
            vec![word],
            false,
            None,
            true,
            &archive,
            |completed, total| progress.push((completed, total)),
        )
        .expect_err("the conversion refusal should fail the export");

    assert!(error.contains("could not be converted"), "{error}");
    assert_eq!(progress, vec![(0, 2), (0, 1)]);
    assert!(!archive.exists(), "a refused export writes nothing");
}
