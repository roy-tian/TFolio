use super::*;
mod archive_links;
use crate::pdfium::watermark::{WatermarkDirection, WatermarkLayout};
pub(super) use archive_links::linked_chapters_pdf;

pub(super) fn build_pdf(objects: &[String]) -> Vec<u8> {
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

pub(super) fn rotated_text_pdf() -> Vec<u8> {
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
pub(super) fn test_pdfium() -> &'static Pdfium {
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
pub(super) fn test_engine() -> &'static PdfiumEngine {
    static ENGINE: std::sync::OnceLock<PdfiumEngine> = std::sync::OnceLock::new();

    ENGINE.get_or_init(|| PdfiumEngine {
        word: crate::convert::WordConverter::nowhere(),
        pdfium: test_pdfium(),
        documents: Mutex::new(HashMap::new()),
        commits: Mutex::new(()),
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

pub(super) fn last_mark(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> Option<u64> {
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
pub(super) fn delete_last_mark(
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
pub(super) fn with_page<T>(
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

pub(super) fn minimal_pdf() -> Vec<u8> {
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        ];
    build_pdf(&objects)
}

pub(super) fn two_page_pdf() -> Vec<u8> {
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

pub(super) fn rotated_blank_pdf(rotation: i32) -> Vec<u8> {
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

pub(super) fn watermark_config(text: &str) -> WatermarkConfig {
    WatermarkConfig {
        text: text.into(),
        width_ratio: 0.8,
        direction: WatermarkDirection::Ascending,
        layout: WatermarkLayout::Single,
    }
}

pub(super) fn quad(left: f32, top: f32, width: f32, height: f32) -> PagePointsRect {
    PagePointsRect {
        height,
        left,
        top,
        width,
    }
}

pub(super) fn rect_style(color: &str, opacity: f32) -> RectStyle {
    RectStyle {
        color: color.to_string(),
        opacity,
    }
}

pub(super) fn rect_effect(kind: RectEffectKind, strength: f32) -> RectEffect {
    RectEffect { kind, strength }
}

pub(super) fn link_pdf() -> Vec<u8> {
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
pub(super) fn text_pdf() -> Vec<u8> {
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

/// A page point is two device pixels on the 200x300 fixtures at this width.
pub(super) const TEST_RENDER_WIDTH: i32 = 400;

/// Ink off the pixels, not the annotation list — one PDFium stored but will
/// not draw counts as working. Split by region: misplaced ink totals the same.
pub(super) fn ink_inside_and_outside(
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

pub(super) fn rendered_rgb(engine: &PdfiumEngine, document_id: u64) -> image::RgbImage {
    engine
        .render_bitmap(document_id, 1, TEST_RENDER_WIDTH, MAX_RENDER_WIDTH)
        .expect("PDFium should render the page")
        .into_rgb8()
}

pub(super) fn rendered_darkness(engine: &PdfiumEngine, document_id: u64, page_number: i32) -> u64 {
    let (inside, outside) = ink_inside_and_outside(engine, document_id, page_number, (0, 0, 0, 0));

    inside + outside
}

/// A directory of its own for a test that touches real files, so parallel
/// tests cannot see each other's.
pub(super) fn scratch_directory(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "tfolio-{label}-{:016x}",
        getrandom::u64().expect("the system should have randomness")
    ));

    fs::create_dir_all(&directory).expect("the temporary directory should be creatable");
    directory
}

pub(super) fn text_note_style(font_size: f32) -> TextNoteStyle {
    TextNoteStyle {
        font_size,
        color: "#000000".into(),
        opacity: 1.0,
    }
}

pub(super) fn note_origin(left: f32, top: f32) -> PagePoint {
    PagePoint { left, top }
}

/// The bytes a document takes up once saved, which is how the tests below
/// tell an embedded font from a subset of one.
pub(super) fn saved_size(engine: &PdfiumEngine, document_id: u64) -> u64 {
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

/// An engine seeded with what the app would have resolved. Safe beside the
/// shared one: nothing reached from here touches PDFium or its serialising lock.
pub(super) fn font_engine(
    system_face: Option<(Vec<u8>, usize)>,
    fallback: Vec<PathBuf>,
) -> PdfiumEngine {
    PdfiumEngine {
        word: crate::convert::WordConverter::at_directory(std::env::temp_dir()),
        pdfium: test_pdfium(),
        documents: Mutex::new(HashMap::new()),
        commits: Mutex::new(()),
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

/// Whether `subset` can draw every character of `text` — the question a note
/// that reached the page as a row of empty boxes answers with `false`.
pub(super) fn draws(subset: &[u8], text: &str) -> bool {
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

pub(super) fn three_page_link_pdf() -> Vec<u8> {
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
pub(super) fn outlined_three_page_pdf() -> Vec<u8> {
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

pub(super) fn archive_bookmarks_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>\nendobj\n".into(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n".into(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".into(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".into(),
        "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R >>\nendobj\n".into(),
        "6 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".into(),
        "7 0 obj\n<< /Type /Outlines /First 8 0 R /Last 10 0 R /Count 4 >>\nendobj\n".into(),
        "8 0 obj\n<< /Title (Part/one) /Parent 7 0 R /Next 9 0 R /Dest [5 0 R /Fit] >>\nendobj\n".into(),
        "9 0 obj\n<< /Title (Part/one) /Parent 7 0 R /Prev 8 0 R /Next 10 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [3 0 R /Fit] >>\nendobj\n".into(),
        "10 0 obj\n<< /Title (Duplicate) /Parent 7 0 R /Prev 9 0 R /Dest [3 0 R /Fit] >>\nendobj\n".into(),
        "11 0 obj\n<< /Title (Detail) /Parent 9 0 R /Dest [4 0 R /Fit] >>\nendobj\n".into(),
    ])
}

pub(super) fn page_fingerprints(
    engine: &PdfiumEngine,
    document_id: u64,
    page_count: i32,
) -> Vec<Vec<u8>> {
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

// One page per offset, each with its bar at that x: distinct fingerprints let
// a merge test say which document's page now sits where.
pub(super) fn banded_pdf(offsets: &[i32]) -> Vec<u8> {
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
