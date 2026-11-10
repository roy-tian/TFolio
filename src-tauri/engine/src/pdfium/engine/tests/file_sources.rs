use super::super::file_sources::SOURCE_CHANGED;
use super::support::*;
use super::*;

fn sources_test_guard() -> MutexGuard<'static, ()> {
    static GUARD: Mutex<()> = Mutex::new(());

    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_source(directory: &Path, name: &str, bytes: Vec<u8>) -> PathBuf {
    let path = directory.join(name);

    fs::write(&path, bytes).expect("the source should write to disk");
    path
}

fn added(engine: &PdfiumEngine, scope: &str, paths: Vec<PathBuf>) -> Vec<u64> {
    engine
        .read_sources(scope, paths, false)
        .expect("the sources should be read")
        .into_iter()
        .map(|info| info.id.expect("every source should be readable"))
        .collect()
}

const PLAIN: FileOptions = FileOptions {
    smart_padding: false,
    per_file_bookmarks: false,
};

/// Adds `ids` to a fresh one-page document of `scope`'s window.
fn insert(engine: &PdfiumEngine, scope: &str, ids: &[u64]) -> Result<PdfStructureUpdate, String> {
    let document = engine
        .open(banded_pdf(&[100]))
        .expect("PDFium should open the document");

    engine.insert_sources(scope, document.id, ids, 2, "own.pdf", PLAIN, None)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_source_is_another_window_s_to_add_only_while_held() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-scope");
    let ids = added(
        engine,
        "held",
        vec![write_source(&directory, "source.pdf", banded_pdf(&[20]))],
    );

    assert!(insert(engine, "elsewhere", &ids).is_err());
    engine.release_source_scope("held", engine.source_release_cutoff());
    assert!(insert(engine, "held", &ids).is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_source_changed_on_disk_is_refused_once_it_must_be_read_again() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-changed");
    let path = write_source(&directory, "source.pdf", banded_pdf(&[20]));
    let ids = added(engine, "changed", vec![path.clone()]);

    engine.evict_sources_for_test("changed");
    fs::write(&path, banded_pdf(&[20, 60])).expect("the file should change");

    let refused = insert(engine, "changed", &ids).expect_err("a changed file is refused");
    assert!(refused.contains(SOURCE_CHANGED), "{refused}");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_source_let_go_is_read_again_while_its_file_stands() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-reread");
    let ids = added(
        engine,
        "reread",
        vec![write_source(&directory, "source.pdf", banded_pdf(&[20]))],
    );

    engine.evict_sources_for_test("reread");
    let added = insert(engine, "reread", &ids).expect("an unchanged file is read again");
    assert_eq!(added.num_pages, 2);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_late_release_spares_what_the_reloaded_page_added_since() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-late-release");
    let before = added(
        engine,
        "reloaded",
        vec![write_source(&directory, "old.pdf", banded_pdf(&[20]))],
    );
    let cutoff = engine.source_release_cutoff();
    let after = added(
        engine,
        "reloaded",
        vec![write_source(&directory, "new.pdf", banded_pdf(&[60]))],
    );

    engine.release_source_scope("reloaded", cutoff);

    assert!(insert(engine, "reloaded", &before).is_err());
    insert(engine, "reloaded", &after)
        .expect("a source added after the release was asked for stays");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_image_is_a_source_of_its_own_and_an_unreadable_file_is_reported() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-kinds");
    let image = directory.join("scan.png");

    DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        60,
        40,
        image::Rgb([20, 40, 160]),
    ))
    .save(&image)
    .expect("the image should write to disk");

    let broken = write_source(&directory, "broken.pdf", b"not a pdf".to_vec());
    let infos = engine
        .read_sources("main", vec![image, broken], false)
        .expect("the sources should be read");

    assert!(matches!(infos[0].kind, MergeSourceKind::Image));
    assert!(infos[0].id.is_some());
    assert_eq!(
        infos[0]
            .pages
            .iter()
            .map(|page| (page.width.round(), page.height.round()))
            .collect::<Vec<_>>(),
        vec![(842.0, 595.0)],
        "a wide image lies on a landscape A4 sheet",
    );
    assert!(
        infos[1].id.is_none(),
        "an unreadable file stays on the list as one"
    );
    assert!(infos[1].error.is_none(), "unreadable says it all for a PDF");

    fs::remove_dir_all(directory).ok();
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

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_image_stands_the_way_its_metadata_says_it_was_held() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-image-orientation");
    // Stored 1600x900 — landscape pixels — but recorded as a quarter turn from
    // upright, which is how a phone stores a portrait photograph.
    let upright = rotated_image_source(&directory, "portrait.jpg", 1600, 900);
    let infos = engine
        .read_sources("main", vec![upright], false)
        .expect("the image should be read");
    let sheet = &infos[0].pages[0];

    assert!(
        (sheet.width - A4_SHORT_POINTS).abs() < 1.0,
        "the sheet should stand upright, not follow the stored pixels: {sheet:?}"
    );
    assert!((sheet.height - A4_LONG_POINTS).abs() < 1.0, "{sheet:?}");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_word_document_that_cannot_convert_is_its_own_kind_of_unreadable() {
    let _sources = sources_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sources-word");
    let word = write_source(&directory, "letter.docx", b"not a document at all".to_vec());
    let infos = engine
        .read_sources("main", vec![word.clone()], true)
        .expect("the file should be answered for");

    // It keeps its kind and says which failure it carries, rather than
    // passing as an ordinary unreadable PDF.
    assert!(matches!(infos[0].kind, MergeSourceKind::Word));
    assert!(infos[0].id.is_none());
    assert!(matches!(
        infos[0].error,
        Some(MergeSourceError::ConversionFailed)
    ));

    // With no converter on offer, the same file is unreadable the plain way.
    let off = engine
        .read_sources("main", vec![word], false)
        .expect("the file should still be answered for");

    assert!(matches!(off[0].kind, MergeSourceKind::Pdf));
    assert!(off[0].id.is_none());
    assert!(off[0].error.is_none());

    fs::remove_dir_all(directory).ok();
}
