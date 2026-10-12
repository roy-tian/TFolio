use super::support::*;
use super::*;
use crate::pdfium::watermark::WatermarkLayout;

#[test]
#[ignore = "requires `bun run pdfium:download` and `bun run fonts:download`"]
fn watermark_preview_hides_only_the_session_watermark_without_editing_the_document() {
    let engine = test_engine();

    for rotation in [0, 90, 180, 270] {
        let source = engine.open(rotated_blank_pdf(rotation)).unwrap();
        engine
            .apply_watermark(source.id, watermark_config("ORIGINAL"))
            .unwrap();
        let bytes = {
            let documents = engine.lock_documents().unwrap();
            documents[&source.id].document.save_to_bytes().unwrap()
        };
        engine.close(source.id).unwrap();
        // A watermark from an earlier session is original content, not ours.
        let document = engine.open(bytes).unwrap();
        engine
            .add_rect(
                document.id,
                1,
                &quad(10.0, 10.0, 40.0, 40.0),
                &rect_style("#00ff00", 1.0),
            )
            .unwrap();
        engine
            .apply_page_numbers(
                document.id,
                PageNumbersConfig {
                    mode: PageNumbersMode::Single,
                    position: PageNumbersPosition::BottomCenter,
                    range: None,
                    start: None,
                    smart_color: false,
                    blank_numbered: true,
                    blank_counted: true,
                },
            )
            .unwrap();
        let background = engine.render_thumbnail(document.id, 1, 400).unwrap();
        assert_eq!(
            engine
                .render_watermark_preview(document.id, 1, 400)
                .unwrap(),
            background
        );

        for layout in [WatermarkLayout::Single, WatermarkLayout::Zebra] {
            let mut config = watermark_config("ALPHA");
            config.layout = layout;
            engine.apply_watermark(document.id, config.clone()).unwrap();
            let live = engine.render_thumbnail(document.id, 1, 400).unwrap();
            assert_ne!(live, background);
            let version = engine.lock_documents().unwrap()[&document.id].content_version;

            for _ in 0..2 {
                assert_eq!(
                    engine
                        .render_watermark_preview(document.id, 1, 400)
                        .unwrap(),
                    background,
                    "rotation {rotation}, {layout:?}: only the session watermark should disappear"
                );
                assert_eq!(engine.render_thumbnail(document.id, 1, 400).unwrap(), live);
                assert_eq!(
                    engine.lock_documents().unwrap()[&document.id].content_version,
                    version
                );
            }
            config.text = "BETA".into();
            engine.apply_watermark(document.id, config).unwrap();
            assert_eq!(
                engine
                    .render_watermark_preview(document.id, 1, 400)
                    .unwrap(),
                background
            );
            engine.remove_watermark(document.id).unwrap();
            assert_eq!(
                engine.render_thumbnail(document.id, 1, 400).unwrap(),
                background
            );
        }
        engine.close(document.id).unwrap();
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_preview_tracks_page_ids_and_leaves_inserted_pages_alone() {
    let engine = test_engine();
    let document = engine.open(text_pdf()).unwrap();
    let background = engine.render_thumbnail(document.id, 1, 224).unwrap();
    engine
        .apply_watermark(document.id, watermark_config("ALPHA"))
        .unwrap();
    engine.insert_blank_page(document.id, 1).unwrap();

    assert_eq!(
        engine
            .render_watermark_preview(document.id, 1, 224)
            .unwrap(),
        engine.render_thumbnail(document.id, 1, 224).unwrap()
    );
    assert_eq!(
        engine
            .render_watermark_preview(document.id, 2, 224)
            .unwrap(),
        background
    );
    for page in [0, -1, 3, i32::MAX] {
        assert!(engine
            .render_watermark_preview(document.id, page, 224)
            .is_err());
    }
    for width in [0, 63, 513, i32::MAX] {
        assert!(engine
            .render_watermark_preview(document.id, 1, width)
            .is_err());
    }
    engine.close(document.id).unwrap();
    assert!(engine
        .render_watermark_preview(document.id, 1, 224)
        .is_err());
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn watermark_preview_refuses_a_mismatched_owned_tail_without_changing_pixels() {
    let engine = test_engine();
    let document = engine.open(text_pdf()).unwrap();
    engine
        .apply_watermark(document.id, watermark_config("ALPHA"))
        .unwrap();
    // Simulate an ownership mismatch without touching the PDF itself.
    {
        let mut documents = engine.lock_documents().unwrap();
        let entry = documents.get_mut(&document.id).unwrap();
        let id = entry.page_ids[0];
        entry
            .owned_content
            .as_mut()
            .unwrap()
            .per_page
            .get_mut(&id)
            .unwrap()
            .segments[0]
            .identities[0] = "FOREIGN".into();
    }
    let before = engine.render_thumbnail(document.id, 1, 224).unwrap();
    let error = engine
        .render_watermark_preview(document.id, 1, 224)
        .unwrap_err();
    assert!(error.contains("different text"), "{error}");
    assert_eq!(
        engine.render_thumbnail(document.id, 1, 224).unwrap(),
        before
    );
    engine.close(document.id).unwrap();
}
