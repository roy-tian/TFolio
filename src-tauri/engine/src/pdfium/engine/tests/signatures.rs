use super::super::signatures::{EXPORT_SIGNED_ERROR, SIGNED_ORIGINAL_CHANGED_ERROR};
use super::support::*;
use super::*;
use crate::pdfium::CompressionOptions;

fn signed_source(label: &str) -> (PathBuf, PathBuf) {
    let directory = scratch_directory(label);
    let source = directory.join("signed.pdf");

    fs::write(&source, signed_pdf()).expect("the fixture should be writable");
    (directory, source)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_signed_file_opens_with_its_signatures_intact() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-intact");

    let signed = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the signed PDF");
    assert_eq!(signed.signatures.count, 1);
    assert!(signed.signatures.intact);

    // From bytes there is no file to check the signature against.
    let unbound = engine
        .open(signed_pdf())
        .expect("PDFium should open the signed PDF");
    assert_eq!(unbound.signatures.count, 1);
    assert!(!unbound.signatures.intact);

    let plain = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    assert_eq!(plain.signatures.count, 0);
    assert!(!plain.signatures.intact);

    // PDFium's rewrite keeps the signature but moves what its range frames.
    let rewritten = directory.join("rewritten.pdf");
    engine
        .save_to(signed.id, &rewritten)
        .expect("PDFium should write the document");
    let reopened = engine
        .open_from_path(rewritten)
        .expect("PDFium should open the rewrite");
    assert_eq!(reopened.signatures.count, 1);
    assert!(!reopened.signatures.intact);

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_signed_original_is_never_saved_over() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-save");
    let original = fs::read(&source).expect("the fixture should be readable");
    let signed = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the signed PDF");

    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("PDFium should turn the page");
    let refused = engine
        .save(signed.id)
        .expect_err("a save would rewrite the signed file");
    assert!(refused.contains("only be exported"), "{refused}");

    let error = engine
        .export_to(signed.id, &source)
        .expect_err("Save As onto the signed file is a save over it");
    assert_eq!(error, EXPORT_SIGNED_ERROR);
    assert_eq!(fs::read(&source).unwrap(), original);

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_unchanged_signed_copy_is_the_file_itself() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-verbatim");
    let original = fs::read(&source).expect("the fixture should be readable");
    let signed = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the signed PDF");
    let copy = directory.join("copy.pdf");

    let outcome = engine
        .export_to(signed.id, &copy)
        .expect("the copy should be written");
    assert!(
        !outcome.saved_to_source,
        "the copy is a signed original too, so the document stays where it was"
    );
    assert!(outcome.signed_original);
    assert_eq!(fs::read(&copy).unwrap(), original);

    let reopened = engine
        .open_from_path(copy.clone())
        .expect("PDFium should open the copy");
    assert!(reopened.signatures.intact);

    // A file replaced since the open is not the one the reader saw.
    fs::write(&source, minimal_pdf()).expect("the source should be replaceable");
    let again = directory.join("again.pdf");
    let error = engine
        .export_to(signed.id, &again)
        .expect_err("the replaced file is not the document");
    assert_eq!(error, SIGNED_ORIGINAL_CHANGED_ERROR);
    assert!(!again.exists(), "a refused copy leaves nothing behind");

    fs::remove_dir_all(&directory).ok();
}

// The edited copy carries no valid signature, so the document may keep saving
// there; only the file it opened from stays out of reach, for every writer.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_edited_signed_document_moves_to_its_copy() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-rebind");
    let original = fs::read(&source).expect("the fixture should be readable");
    let signed = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the signed PDF");
    let copy = directory.join("copy.pdf");

    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("PDFium should turn the page");
    let outcome = engine
        .export_to(signed.id, &copy)
        .expect("the copy should be written");
    assert!(outcome.saved_to_source);
    assert!(!outcome.signed_original);
    assert_ne!(fs::read(&copy).unwrap(), original);

    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("PDFium should turn the page");
    engine
        .save(signed.id)
        .expect("the copy is the document's own file now");

    let error = engine
        .export_to(signed.id, &source)
        .expect_err("the signed file stays out of reach after the move");
    assert_eq!(error, EXPORT_SIGNED_ERROR);

    let other = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let error = engine
        .export_to(other.id, &source)
        .expect_err("no other document may replace the signed file either");
    assert_eq!(error, EXPORT_SIGNED_ERROR);
    let error = engine
        .export_compressed(
            signed.id,
            &source,
            CompressionOptions { image_dpi: None },
            |_, _| {},
        )
        .expect_err("nor may a compressed copy");
    assert_eq!(error, EXPORT_SIGNED_ERROR);
    assert_eq!(fs::read(&source).unwrap(), original);

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_organize_source_reports_its_signatures() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-organize");
    let plain = directory.join("plain.pdf");
    fs::write(&plain, minimal_pdf()).expect("the fixture should be writable");

    let original = fs::read(&source).expect("the fixture should be readable");
    let infos = engine
        .add_organize_sources("signatures-organize", vec![source.clone(), plain], false)
        .expect("the sources should be read");
    assert_eq!(infos[0].signatures.count, 1);
    assert!(infos[0].signatures.intact);
    assert_eq!(infos[1].signatures.count, 0);

    // An assembly saves through Save As; no document may replace the source.
    let other = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let error = engine
        .export_to(other.id, &source)
        .expect_err("the signed source is out of reach while added");
    assert_eq!(error, EXPORT_SIGNED_ERROR);
    assert_eq!(fs::read(&source).unwrap(), original);

    engine.release_organize_scope("signatures-organize", u64::MAX);
    fs::remove_dir_all(&directory).ok();
}
