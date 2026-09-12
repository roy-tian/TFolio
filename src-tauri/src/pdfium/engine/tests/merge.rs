use super::super::io::{archive_pdf_name, bookmark_title, remapped_outline};
use super::support::*;
use super::*;

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
