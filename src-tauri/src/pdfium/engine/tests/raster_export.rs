use super::support::*;
use super::*;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn image_watermark_export_combines_content_and_preserves_display_geometry() {
    let engine = test_engine();
    let directory = scratch_directory("raster-watermark");

    for (index, bytes) in [text_pdf(), rotated_text_pdf(), link_pdf()]
        .into_iter()
        .enumerate()
    {
        let document = engine.open(bytes).unwrap();
        let mut config = watermark_config("COPY");
        config.rasterize = true;
        engine.apply_watermark(document.id, config.clone()).unwrap();
        let before = rendered_rgb(engine, document.id);
        let destination = directory.join(format!("{index}.pdf"));
        engine.export_to(document.id, &destination).unwrap();
        let reopened = engine.open(fs::read(&destination).unwrap()).unwrap();
        assert_eq!(reopened.pages[0].width, document.pages[0].width);
        assert_eq!(reopened.pages[0].height, document.pages[0].height);
        let after = rendered_rgb(engine, reopened.id);
        assert_eq!(before.dimensions(), after.dimensions());
        let mean_error = before
            .as_raw()
            .iter()
            .zip(after.as_raw())
            .map(|(left, right)| u64::from(left.abs_diff(*right)))
            .sum::<u64>() as f64
            / before.as_raw().len() as f64;
        assert!(
            mean_error < 3.0,
            "the flattened page changed appearance: {mean_error}"
        );
        {
            let documents = engine.lock_documents().unwrap();
            let page = documents[&reopened.id].document.pages().get(0).unwrap();
            assert_eq!(page.objects().len(), 1);
            assert!(page.objects().get(0).unwrap().as_image_object().is_some());
            assert_eq!(page.text().unwrap().all(), "");
            assert!(page.annotations().is_empty());
        }
        engine.close(reopened.id).unwrap();

        config.rasterize = false;
        engine.apply_watermark(document.id, config).unwrap();
        let editable = directory.join(format!("editable-{index}.pdf"));
        engine.export_to(document.id, &editable).unwrap();
        let reopened = engine.open(fs::read(editable).unwrap()).unwrap();
        {
            let documents = engine.lock_documents().unwrap();
            let page = documents[&reopened.id].document.pages().get(0).unwrap();
            assert!(page.text().unwrap().all().contains("COPY"));
        }
        engine.close(reopened.id).unwrap();
        engine.close(document.id).unwrap();
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn image_watermarks_preserve_bookmarks_and_leave_the_source_intact() {
    let engine = test_engine();
    let directory = scratch_directory("raster-watermark-batch");
    let source = directory.join("source.pdf");
    let original = outlined_three_page_pdf();
    fs::write(&source, &original).unwrap();
    let mut config = watermark_config("ARCHIVE");
    config.rasterize = true;
    let document = engine.open(original.clone()).unwrap();
    engine.apply_watermark(document.id, config).unwrap();
    let destination = directory.join("copy.pdf");
    engine.export_to(document.id, &destination).unwrap();
    let bytes = fs::read(&destination).unwrap();
    engine.close(document.id).unwrap();
    assert_eq!(fs::read(&source).unwrap(), original);
    let reopened = engine.open(bytes).unwrap();
    assert_eq!(reopened.num_pages, 3);
    assert_eq!(reopened.outline[0].title, "Chapter");
    assert_eq!(reopened.outline[0].page_number, Some(3));
    {
        let documents = engine.lock_documents().unwrap();
        for page in documents[&reopened.id].document.pages().iter() {
            assert_eq!(page.objects().len(), 1);
            assert!(page.objects().get(0).unwrap().as_image_object().is_some());
            assert_eq!(page.text().unwrap().all(), "");
        }
    }
    engine.close(reopened.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn cancelled_image_export_does_not_replace_an_existing_file() {
    let engine = test_engine();
    let document = engine.open(text_pdf()).unwrap();
    let mut config = watermark_config("COPY");
    config.rasterize = true;
    engine.apply_watermark(document.id, config).unwrap();
    let directory = scratch_directory("raster-watermark-cancel");
    let destination = directory.join("existing.pdf");
    fs::write(&destination, b"existing file").unwrap();
    let operation = engine.begin_operation(OperationTarget::Document(document.id));
    engine.cancel_document_work(document.id);
    {
        let mut documents = engine.lock_documents().unwrap();
        let entry = open_entry_mut(&mut documents, document.id).unwrap();
        assert!(engine
            .write_document(entry, &destination, &operation)
            .is_err());
    }
    assert_eq!(fs::read(destination).unwrap(), b"existing file");
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}
