use std::io::Read;
use zip::ZipArchive;

use super::support::*;
use super::*;
use crate::pdfium::archive::{ArchiveOptions, ImageFormat};

fn images(image_format: ImageFormat, dpi: u32, pages: &[u32]) -> ArchiveOptions {
    ArchiveOptions::Images {
        image_format,
        dpi,
        pages: pages.to_vec(),
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_images_include_every_page_and_current_edits() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    engine
        .apply_watermark(document.id, watermark_config("COPY"))
        .unwrap();
    let directory = scratch_directory("archive-images");
    for (image_format, extension) in [(ImageFormat::Jpg, "jpg"), (ImageFormat::Png, "png")] {
        let destination = directory.join(format!("pages-{extension}.zip"));
        let mut progress = Vec::new();
        assert!(engine
            .export_archive(
                document.id,
                &destination,
                images(image_format, 300, &[1, 2, 3]),
                |completed, total| progress.push((completed, total))
            )
            .unwrap());
        assert_eq!(progress.last(), Some(&(3, 3)));
        let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
        for index in 0..3 {
            let mut bytes = Vec::new();
            zip.by_name(&format!("{:04}.{extension}", index + 1))
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap().into_rgb8();
            assert!(image.width() > 800);
            assert!(image.height() > 800);
            assert!(image
                .pixels()
                .any(|pixel| pixel.0.iter().any(|channel| *channel < 240)));
        }
    }
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_images_follow_the_selection_and_its_own_page_numbers() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-image-selection");
    let destination = directory.join("selection.zip");
    let mut progress = Vec::new();
    assert!(engine
        .export_archive(
            document.id,
            &destination,
            // Repeats and order are the sender's business; the archive names
            // what the reader sees, not the position in this list.
            images(ImageFormat::Jpg, 150, &[3, 1, 1]),
            |completed, total| progress.push((completed, total))
        )
        .unwrap());
    assert_eq!(progress.first(), Some(&(0, 2)));
    assert_eq!(progress.last(), Some(&(2, 2)));
    let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 2);
    for name in ["0001.jpg", "0003.jpg"] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        let image = image::load_from_memory(&bytes).unwrap().into_rgb8();
        assert!(image.width() > 400);
        assert!(image.height() > 400);
    }
    assert!(zip.by_name("0002.jpg").is_err());
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_images_reject_dpi_and_page_bounds() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-image-bounds");
    let destination = directory.join("none.zip");
    for options in [
        images(ImageFormat::Jpg, 71, &[1]),
        images(ImageFormat::Jpg, 601, &[1]),
        images(ImageFormat::Jpg, 150, &[]),
        images(ImageFormat::Jpg, 150, &[0]),
        images(ImageFormat::Jpg, 150, &[4]),
        images(ImageFormat::Jpg, 150, &[1, 4]),
    ] {
        assert!(engine
            .export_archive(document.id, &destination, options, |_, _| {})
            .is_err());
        assert!(!destination.exists());
    }
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_split_preserves_front_matter_and_remaps_bookmarks() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-bookmarks");
    let destination = directory.join("split.zip");
    assert!(engine
        .export_archive(
            document.id,
            &destination,
            ArchiveOptions::Bookmarks,
            |_, _| {}
        )
        .unwrap());
    let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 2);
    for (name, count) in [("001.pdf", 2), ("002-Chapter.pdf", 1)] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        let reopened = engine.open(bytes).unwrap();
        assert_eq!(reopened.num_pages, count);
        if count == 1 {
            assert_eq!(reopened.outline[0].title, "Chapter");
            assert_eq!(reopened.outline[0].page_number, Some(1));
        }
        engine.close(reopened.id).unwrap();
    }
    assert_eq!(
        engine.lock_documents().unwrap()[&document.id]
            .document
            .pages()
            .len(),
        3
    );
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_pages_split_writes_one_single_page_pdf_each() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-per-page");
    let destination = directory.join("pages.zip");
    let mut progress = Vec::new();
    assert!(engine
        .export_archive(
            document.id,
            &destination,
            ArchiveOptions::Pages,
            |completed, total| progress.push((completed, total))
        )
        .unwrap());
    assert_eq!(progress.last(), Some(&(3, 3)));
    let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 3);
    for name in ["0001.pdf", "0002.pdf", "0003.pdf"] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        let reopened = engine.open(bytes).unwrap();
        assert_eq!(reopened.num_pages, 1);
        engine.close(reopened.id).unwrap();
    }
    assert_eq!(
        engine.lock_documents().unwrap()[&document.id]
            .document
            .pages()
            .len(),
        3
    );
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_cancellation_preserves_destination_and_removes_temporary_file() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-cancel");
    let destination = directory.join("existing.zip");
    fs::write(&destination, b"existing archive").unwrap();
    for options in [
        images(ImageFormat::Jpg, 300, &[1, 2, 3]),
        images(ImageFormat::Png, 300, &[1, 2, 3]),
        ArchiveOptions::Bookmarks,
        ArchiveOptions::Pages,
    ] {
        assert!(!engine
            .export_archive(document.id, &destination, options, |completed, _| {
                if completed == 1 {
                    engine.cancel_operation(OperationTarget::Archive(document.id));
                }
            })
            .unwrap());
        assert_eq!(fs::read(&destination).unwrap(), b"existing archive");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    }
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_split_orders_unique_boundaries_and_preserves_watermarks() {
    let engine = test_engine();
    let document = engine.open(archive_bookmarks_pdf()).unwrap();
    let config = watermark_config("COPY");
    engine.apply_watermark(document.id, config).unwrap();
    let directory = scratch_directory("archive-nested-bookmarks");
    let destination = directory.join("split.zip");
    assert!(engine
        .export_archive(
            document.id,
            &destination,
            ArchiveOptions::Bookmarks,
            |_, _| {}
        )
        .unwrap());
    let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 2);
    for (name, count) in [("001-Part_one.pdf", 2), ("002-Part_one.pdf", 1)] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        let reopened = engine.open(bytes).unwrap();
        assert_eq!(reopened.num_pages, count);
        assert_eq!(reopened.outline[0].page_number, Some(1));
        if count == 2 {
            assert_eq!(reopened.outline.len(), 2);
            assert_eq!(reopened.outline[0].items[0].title, "Detail");
            assert_eq!(reopened.outline[0].items[0].page_number, Some(2));
        }
        {
            let documents = engine.lock_documents().unwrap();
            for page in documents[&reopened.id].document.pages().iter() {
                assert!(page.text().unwrap().all().contains("COPY"));
            }
        }
        engine.close(reopened.id).unwrap();
    }
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_refuses_missing_bookmarks_and_source_aliases() {
    let engine = test_engine();
    let directory = scratch_directory("archive-refusals");
    let source = directory.join("source.pdf");
    fs::write(&source, text_pdf()).unwrap();
    let document = engine.open_from_path(source.clone()).unwrap();
    let destination = directory.join("split.zip");
    assert!(engine
        .export_archive(
            document.id,
            &destination,
            ArchiveOptions::Bookmarks,
            |_, _| {}
        )
        .is_err());
    assert!(!destination.exists());
    assert!(engine
        .export_archive(
            document.id,
            &source,
            images(ImageFormat::Png, 300, &[1]),
            |_, _| {}
        )
        .is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &destination).unwrap();
        assert!(engine
            .export_archive(
                document.id,
                &destination,
                images(ImageFormat::Png, 300, &[1]),
                |_, _| {}
            )
            .is_err());
    }
    assert_eq!(fs::read(&source).unwrap(), text_pdf());
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_refuses_a_destination_opened_while_it_was_written() {
    let engine = test_engine();
    let document = engine.open(outlined_three_page_pdf()).unwrap();
    let directory = scratch_directory("archive-late-open");
    let destination = directory.join("late.pdf");
    fs::write(&destination, text_pdf()).unwrap();
    let mut opened = None;

    // Progress reports off the lock, where another window could open the very
    // file the archive is about to replace.
    let outcome =
        engine.export_archive(document.id, &destination, ArchiveOptions::Pages, |_, _| {
            if opened.is_none() {
                opened = Some(engine.open_from_path(destination.clone()).unwrap());
            }
        });

    assert!(outcome.is_err());
    assert_eq!(fs::read(&destination).unwrap(), text_pdf());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    engine.close(opened.unwrap().id).unwrap();
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn archive_split_restores_links_after_saving_and_reopening() {
    let engine = test_engine();
    let source = engine.open(linked_chapters_pdf()).unwrap();
    let directory = scratch_directory("archive-links");
    let destination = directory.join("split.zip");
    assert!(engine
        .export_archive(
            source.id,
            &destination,
            ArchiveOptions::Bookmarks,
            |_, _| {}
        )
        .unwrap());
    let mut zip = ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 3);
    for (name, count) in [("001.pdf", 1), ("002-One.pdf", 2), ("003-Two.pdf", 1)] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        let reopened = engine.open(bytes).unwrap();
        assert_eq!(reopened.num_pages, count);
        {
            let documents = engine.lock_documents().unwrap();
            let document = &documents[&reopened.id].document;
            let page = document.pages().get(0).unwrap();
            if count == 1 {
                let annotation = page.annotations().get(0).unwrap();
                let link = annotation.as_link_annotation().unwrap().link().unwrap();
                assert_eq!(link.destination().unwrap().page_index().unwrap(), 0);
            } else {
                assert_eq!(page.annotations().len(), 6);
                assert!(page
                    .annotations()
                    .get(0)
                    .unwrap()
                    .as_highlight_annotation()
                    .is_some());
                for index in 1..=3 {
                    let annotation = page.annotations().get(index).unwrap();
                    let link = annotation.as_link_annotation().unwrap().link().unwrap();
                    let destination = link.destination().unwrap();
                    assert_eq!(destination.page_index().unwrap(), 1);
                    match (index, destination.view_settings().unwrap()) {
                        (
                            1,
                            PdfDestinationViewSettings::SpecificCoordinatesAndZoom(
                                x,
                                Some(y),
                                Some(zoom),
                            ),
                        ) => {
                            assert!(x.is_none());
                            assert_eq!(y.value, 240.0);
                            assert_eq!(zoom, 1.5);
                        }
                        (2, PdfDestinationViewSettings::FitPageHorizontallyToWindow(Some(y))) => {
                            assert_eq!(y.value, 220.0)
                        }
                        (3, PdfDestinationViewSettings::FitPageToWindow) => {}
                        _ => panic!("the link's view settings changed"),
                    }
                }
                let annotation = page.annotations().get(4).unwrap();
                let link = annotation.as_link_annotation().unwrap().link().unwrap();
                assert!(link.destination().is_none());
                assert!(link.action().is_none());
                let annotation = page.annotations().get(5).unwrap();
                let link = annotation.as_link_annotation().unwrap().link().unwrap();
                assert_eq!(
                    link.action()
                        .unwrap()
                        .as_uri_action()
                        .unwrap()
                        .uri()
                        .unwrap(),
                    "https://example.com"
                );
                let page = document.pages().get(1).unwrap();
                let annotation = page.annotations().get(0).unwrap();
                let link = annotation.as_link_annotation().unwrap().link().unwrap();
                assert_eq!(link.destination().unwrap().page_index().unwrap(), 0);
            }
        }
        engine.close(reopened.id).unwrap();
    }
    {
        let documents = engine.lock_documents().unwrap();
        let page = documents[&source.id].document.pages().get(1).unwrap();
        let annotation = page.annotations().get(4).unwrap();
        let link = annotation.as_link_annotation().unwrap().link().unwrap();
        let action = link.action().unwrap();
        assert_eq!(
            action
                .as_local_destination_action()
                .unwrap()
                .destination()
                .unwrap()
                .page_index()
                .unwrap(),
            3
        );
    }
    engine.close(source.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}
