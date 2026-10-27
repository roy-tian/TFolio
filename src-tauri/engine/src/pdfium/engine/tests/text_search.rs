use super::support::*;

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

// One text object per glyph or word, as fragmented PDFs have it: advances
// shorter than the glyphs so boxes overlap, spaces of their own, a kerned TJ,
// and a large glyph reaching into the lines around it.
fn fragmented_text_pdf() -> Vec<u8> {
    let content = concat!(
        "BT\n/F1 24 Tf\n40 340 Td (F) Tj\n8 0 Td (r) Tj\n8 0 Td (a) Tj\n10 0 Td (g) Tj\n",
        "20 0 Td ( ) Tj\n8 0 Td (m) Tj\nET\n",
        "BT\n/F1 12 Tf\n40 300 Td (word) Tj ( ) Tj (next) Tj\n",
        "0 -14 Td [(K) 400 (e) -300 (r) (n)] TJ\nET\n",
        "BT\n/F1 40 Tf\n70 290 Td (B) Tj\nET\n",
    );
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n".to_string(),
        format!(
            "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
            content.len()
        ),
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
    ];

    build_pdf(&objects)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn reads_each_text_run_as_pdfium_reads_its_rect() {
    let engine = test_engine();
    let document = engine
        .open(fragmented_text_pdf())
        .expect("PDFium should open the fragmented fixture");

    let (runs, segments) = with_page(engine, document.id, 1, |page| {
        let runs: Vec<_> = crate::pdfium::engine::text_runs::page_runs(engine.raw_bindings, page)
            .expect("the page's text should load")
            .into_iter()
            .map(|run| {
                let bounds = run.bounds;

                (
                    run.text,
                    [bounds.left, bounds.bottom, bounds.right, bounds.top],
                )
            })
            .collect();
        // pdfium-render's segments, which ask PDFium for each rect's text.
        let text = page
            .text()
            .expect("pdfium-render should load the page's text");
        let segments: Vec<_> = text
            .segments()
            .iter()
            .map(|segment| {
                let bounds = segment.bounds();

                (
                    segment.text(),
                    [
                        bounds.left().value,
                        bounds.bottom().value,
                        bounds.right().value,
                        bounds.top().value,
                    ],
                )
            })
            .collect();

        (runs, segments)
    });

    assert_eq!(runs, segments);
    assert!(
        segments.iter().any(|(text, _)| text.contains("\r\n"))
            && segments.iter().any(|(text, _)| text.ends_with(' ')),
        "the fixture should reach a line break and a kept space: {segments:?}"
    );
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
fn a_search_lets_the_lock_go_and_starts_over_after_an_edit() {
    let engine = test_engine();
    let document = engine
        .open(wrapped_search_pdf())
        .expect("PDFium should open the search fixture");
    let mut edited = false;

    // One page a batch; the edit between them takes the lock itself, so a
    // search still holding it would never return.
    let outcome = engine
        .search_in_batches(document.id, "wrapped phrase", 1, &mut || {
            if !edited {
                edited = true;
                engine
                    .delete_pages(document.id, &[1], 1)
                    .expect("the edit should get the lock between batches");
            }
        })
        .expect("PDFium should search the whole document");

    assert!(edited);
    assert!(!outcome.cancelled);
    // Found again from the start: the first page and its match are gone, and
    // the one left is on what is now page one.
    assert_eq!(outcome.matches.len(), 1);
    assert_eq!(outcome.matches[0].page_number, 1);

    engine
        .close(document.id)
        .expect("the search fixture should close");
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
