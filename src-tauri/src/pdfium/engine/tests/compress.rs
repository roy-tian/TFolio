use super::support::*;
use super::*;
use crate::pdfium::compress::CompressionOptions;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn lossless_compression_keeps_text_and_bookmarks() {
    let engine = test_engine();
    let directory = scratch_directory("compress-lossless");

    for (index, bytes) in [text_pdf(), outlined_three_page_pdf()]
        .into_iter()
        .enumerate()
    {
        let document = engine.open(bytes).unwrap();
        let expected_pages = {
            let documents = engine.lock_documents().unwrap();
            documents[&document.id].document.pages().len()
        };
        let destination = directory.join(format!("{index}.pdf"));
        assert!(engine
            .export_compressed(
                document.id,
                &destination,
                CompressionOptions::Lossless,
                |_, _| {}
            )
            .unwrap());
        // PDFium reopening the bytes is the check the format still holds.
        let reopened = engine.open(fs::read(&destination).unwrap()).unwrap();

        {
            let documents = engine.lock_documents().unwrap();
            let entry = &documents[&reopened.id];

            assert_eq!(entry.document.pages().len(), expected_pages);
            if index == 0 {
                let page = entry.document.pages().get(0).unwrap();
                assert!(page.text().unwrap().all().contains("Hello"));
            } else {
                assert_eq!(
                    collect_bookmark_siblings(entry.document.bookmarks().root())[0].title,
                    "Chapter"
                );
            }
        }

        engine.close(reopened.id).unwrap();
        engine.close(document.id).unwrap();
    }

    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rasterized_compression_announces_pages_and_preserves_the_outline() {
    let engine = test_engine();
    let directory = scratch_directory("compress-rasterized");
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let mut announcements = Vec::new();
    let destination = directory.join("copy.pdf");

    assert!(engine
        .export_compressed(
            document.id,
            &destination,
            CompressionOptions::Rasterized {
                dpi: 96,
                quality: 60,
            },
            |completed, total| announcements.push((completed, total)),
        )
        .unwrap());

    assert_eq!(announcements.first(), Some(&(0, 3)));
    assert_eq!(announcements.last(), Some(&(3, 3)));

    let reopened = engine.open(fs::read(&destination).unwrap()).unwrap();
    assert_eq!(reopened.num_pages, 3);
    assert_eq!(reopened.outline[0].title, "Chapter");
    assert_eq!(reopened.outline[0].page_number, Some(3));

    {
        let documents = engine.lock_documents().unwrap();
        let entry = &documents[&reopened.id];

        for page in entry.document.pages().iter() {
            assert_eq!(page.objects().len(), 1);
            assert!(page.objects().get(0).unwrap().as_image_object().is_some());
            assert_eq!(page.text().unwrap().all(), "");
        }
    }

    engine.close(reopened.id).unwrap();
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn compression_estimates_report_both_sizes() {
    let engine = test_engine();
    let document = engine.open(two_page_pdf()).unwrap();

    let lossless = engine
        .estimate_compression(document.id, CompressionOptions::Lossless)
        .unwrap()
        .expect("an uncancelled estimate should answer");
    assert!(lossless.exact);
    assert!(lossless.original_bytes > 0);
    assert!(lossless.estimated_bytes > 0);

    let rasterized = engine
        .estimate_compression(
            document.id,
            CompressionOptions::Rasterized {
                dpi: 150,
                quality: 75,
            },
        )
        .unwrap()
        .expect("an uncancelled estimate should answer");
    assert!(!rasterized.exact);
    assert!(rasterized.original_bytes > 0);
    assert!(rasterized.estimated_bytes > 0);

    engine.close(document.id).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_stopped_rasterized_export_abandons_without_failing() {
    let engine = test_engine();
    let directory = scratch_directory("compress-stop");
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let destination = directory.join("copy.pdf");
    let mut asked = false;

    // Cancelling from the progress callback stops the run between pages —
    // the reader's own Stop button does exactly this through the command.
    let completed = engine
        .export_compressed(
            document.id,
            &destination,
            CompressionOptions::Rasterized {
                dpi: 96,
                quality: 60,
            },
            |completed, _total| {
                if completed == 1 && !asked {
                    asked = true;
                    engine.cancel_operation(OperationTarget::Compress(document.id));
                }
            },
        )
        .unwrap();

    assert!(
        !completed,
        "a reader-initiated stop abandons, it does not fail"
    );
    assert!(!destination.exists(), "an abandoned export leaves no file");

    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn compression_refuses_levels_out_of_bounds() {
    let engine = test_engine();
    let document = engine.open(two_page_pdf()).unwrap();
    let directory = scratch_directory("compress-bounds");
    let destination = directory.join("copy.pdf");

    for levels in [
        CompressionOptions::Rasterized {
            dpi: 36,
            quality: 75,
        },
        CompressionOptions::Rasterized {
            dpi: 600,
            quality: 75,
        },
        CompressionOptions::Rasterized {
            dpi: 150,
            quality: 0,
        },
        CompressionOptions::Rasterized {
            dpi: 150,
            quality: 101,
        },
    ] {
        assert!(engine.estimate_compression(document.id, levels).is_err());
        assert!(engine
            .export_compressed(document.id, &destination, levels, |_, _| {})
            .is_err());
    }

    assert!(!destination.exists());
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_compressed_copy_refuses_to_replace_an_open_pdf() {
    let engine = test_engine();
    let directory = scratch_directory("compress-refusal");
    let source = directory.join("source.pdf");
    fs::write(&source, text_pdf()).unwrap();
    let document = engine.open_from_path(source.clone()).unwrap();

    let refused = engine
        .export_compressed(
            document.id,
            &source,
            CompressionOptions::Lossless,
            |_, _| {},
        )
        .unwrap_err();
    assert!(refused.contains("cannot replace an open PDF"));

    // The source's bytes are the refusal's promise: nothing was written.
    let before = fs::read(&source).unwrap();
    engine.close(document.id).unwrap();
    assert_eq!(fs::read(&source).unwrap(), before);
    fs::remove_dir_all(directory).unwrap();
}
