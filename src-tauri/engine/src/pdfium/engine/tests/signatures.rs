use std::io::Read;
use zip::ZipArchive;

use super::super::signature_flatten::flatten_signatures;
use super::super::signatures::{
    EXPORT_SIGNED_ERROR, SIGNATURES_UNDECIDED_ERROR, SIGNED_ORIGINAL_CHANGED_ERROR,
};
use super::support::*;
use super::*;
use crate::pdfium::archive::ArchiveOptions;
use crate::pdfium::{CompressionOptions, SignatureDecision};

fn signed_source(label: &str) -> (PathBuf, PathBuf) {
    let directory = scratch_directory(label);
    let source = directory.join("signed.pdf");

    fs::write(&source, signed_pdf()).expect("the fixture should be writable");
    (directory, source)
}

/// The seal's red, as the first page renders.
fn seal_pixels(engine: &PdfiumEngine, document_id: u64) -> usize {
    rendered_rgb(engine, document_id)
        .pixels()
        .filter(|pixel| pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80)
        .count()
}

/// Signatures as PDFium counts them in the document's own rewrite.
fn signatures_written(engine: &PdfiumEngine, document_id: u64, directory: &Path) -> usize {
    let written = directory.join(format!("written-{document_id}.pdf"));

    engine
        .save_to(document_id, &written)
        .expect("PDFium should write the document");
    engine
        .open(fs::read(&written).expect("the rewrite should be readable"))
        .expect("PDFium should open the rewrite")
        .signatures
        .count
}

fn annotation_types(engine: &PdfiumEngine, document_id: u64) -> Vec<PdfPageAnnotationType> {
    with_page(engine, document_id, 1, |page| {
        page.annotations()
            .iter()
            .map(|annotation| annotation.annotation_type())
            .collect()
    })
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
    assert!(signed.pages[0].signed, "the seal's page is marked");

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
    assert!(!plain.pages[0].signed);

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
        .decide_signatures(signed.id, SignatureDecision::Keep)
        .expect("the answer should be recorded");
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
    assert!(outcome.signatures.intact);
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
        .decide_signatures(signed.id, SignatureDecision::Keep)
        .expect("the answer should be recorded");
    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("PDFium should turn the page");
    let outcome = engine
        .export_to(signed.id, &copy)
        .expect("the copy should be written");
    assert!(outcome.saved_to_source);
    assert!(!outcome.signatures.intact);
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
fn a_file_source_reports_its_signatures() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-source");
    let plain = directory.join("plain.pdf");
    fs::write(&plain, minimal_pdf()).expect("the fixture should be writable");

    let original = fs::read(&source).expect("the fixture should be readable");
    let infos = engine
        .read_sources("signatures-source", vec![source.clone(), plain], false)
        .expect("the sources should be read");
    assert_eq!(infos[0].signatures.count, 1);
    assert!(infos[0].signatures.intact);
    assert!(infos[0].pages[0].signed);
    assert_eq!(infos[1].signatures.count, 0);

    // No document may write over the source while it is read for adding.
    let other = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let error = engine
        .export_to(other.id, &source)
        .expect_err("the signed source is out of reach while added");
    assert_eq!(error, EXPORT_SIGNED_ERROR);
    assert_eq!(fs::read(&source).unwrap(), original);

    engine.release_source_scope("signatures-source", u64::MAX);
    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_edit_waits_for_the_reader_to_say_what_becomes_of_the_signatures() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-decide");
    let signed = engine
        .open_from_path(source)
        .expect("PDFium should open the signed PDF");

    let refused = engine
        .rotate_pages(signed.id, &[1], 90)
        .expect_err("an edit would break the signatures unasked");
    assert_eq!(refused, SIGNATURES_UNDECIDED_ERROR);
    assert_eq!(
        engine
            .add_rect(
                signed.id,
                1,
                &quad(10.0, 10.0, 20.0, 20.0),
                &rect_style("#000000", 1.0)
            )
            .map(|_| ()),
        Err(SIGNATURES_UNDECIDED_ERROR.to_string())
    );

    let decided = engine
        .decide_signatures(signed.id, SignatureDecision::Keep)
        .expect("the answer should be recorded");
    assert_eq!(decided.decision, Some(SignatureDecision::Keep));
    let turned = engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("a kept signature lets the edit through");
    assert!(turned.pages[0].signed, "the mark follows its page");

    // An answer stands once it has acted: the edit above kept the fields.
    let again = engine
        .decide_signatures(signed.id, SignatureDecision::Flatten)
        .expect("the answer should be read back");
    assert_eq!(again.decision, Some(SignatureDecision::Keep));
    engine
        .flatten_signatures(signed.id)
        .expect_err("kept signatures are not flattened");
    assert_eq!(signatures_written(engine, signed.id, &directory), 1);

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_flatten_draws_the_seal_in_and_keeps_the_page_s_other_annotations() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-flatten");
    let signed = engine
        .open_from_path(source)
        .expect("PDFium should open the signed PDF");
    let seal = seal_pixels(engine, signed.id);
    assert!(seal > 0, "the fixture's seal should show");
    assert_eq!(
        annotation_types(engine, signed.id),
        [PdfPageAnnotationType::Widget, PdfPageAnnotationType::Link]
    );

    let update = engine
        .flatten_signatures(signed.id)
        .expect("PDFium should flatten the signatures");
    assert!(update.signatures.flattened);
    assert!(
        !update.pages[0].signed,
        "a flattened page carries no signature"
    );
    assert!(
        update.signatures.intact,
        "still bound to the signed file, which stays as it was"
    );
    assert_eq!(seal_pixels(engine, signed.id), seal);
    assert_eq!(
        annotation_types(engine, signed.id),
        [PdfPageAnnotationType::Link]
    );
    assert_eq!(signatures_written(engine, signed.id, &directory), 0);

    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("a flattened document takes edits");
    engine
        .flatten_signatures(signed.id)
        .expect("a second flatten has nothing left to do");

    fs::remove_dir_all(&directory).ok();
}

// A new file of a signed document's pages flattens its own copy: the document
// itself stays signed, unchanged, and still copies to the very file it is.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_new_file_flattens_its_copy_and_leaves_the_document_signed() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-outputs");
    let original = fs::read(&source).expect("the fixture should be readable");
    let signed = engine
        .open_from_path(source)
        .expect("PDFium should open the signed PDF");
    let compressed = directory.join("compressed.pdf");
    let options = CompressionOptions { image_dpi: None };

    assert_eq!(
        engine.extract_pages(signed.id, &[1]).map(|info| info.id),
        Err(SIGNATURES_UNDECIDED_ERROR.to_string())
    );
    assert_eq!(
        engine.export_compressed(signed.id, &compressed, options, |_, _| {}),
        Err(SIGNATURES_UNDECIDED_ERROR.to_string())
    );

    engine
        .decide_signatures(signed.id, SignatureDecision::Flatten)
        .expect("the answer should be recorded");

    let extracted = engine
        .extract_pages(signed.id, &[1])
        .expect("the new document should open");
    assert!(seal_pixels(engine, extracted.id) > 0);
    assert_eq!(
        annotation_types(engine, extracted.id),
        [PdfPageAnnotationType::Link]
    );

    let other = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    engine
        .insert_pages_from_document(other.id, signed.id, &[1], 1, None)
        .expect("the pages should go in");
    assert_eq!(
        with_page(engine, other.id, 1, |page| page.annotations().len()),
        1,
        "the inserted page keeps its link and loses only the signature"
    );

    assert!(engine
        .export_compressed(signed.id, &compressed, options, |_, _| {})
        .expect("the compressed copy should be written"));
    let reopened = engine
        .open(fs::read(&compressed).expect("the copy should be readable"))
        .expect("PDFium should open the copy");
    assert_eq!(reopened.signatures.count, 0);
    assert!(seal_pixels(engine, reopened.id) > 0);

    let copy = directory.join("copy.pdf");
    engine
        .export_to(signed.id, &copy)
        .expect("the unchanged document copies as itself");
    assert_eq!(fs::read(&copy).unwrap(), original);

    fs::remove_dir_all(&directory).ok();
}

// A split's links are found again by their place among the page's
// annotations, which taking the signature out before them would shift.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_bookmark_split_flattens_its_parts_and_keeps_their_links() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-split");
    let signed = engine
        .open_from_path(source)
        .expect("PDFium should open the signed PDF");
    let destination = directory.join("split.zip");

    engine
        .decide_signatures(signed.id, SignatureDecision::Flatten)
        .expect("the answer should be recorded");
    assert!(engine
        .export_archive(
            signed.id,
            &destination,
            ArchiveOptions::Bookmarks,
            |_, _| {}
        )
        .expect("the split should be written"));

    let mut zip = ZipArchive::new(fs::File::open(&destination).unwrap()).unwrap();
    let mut bytes = Vec::new();
    zip.by_index(0).unwrap().read_to_end(&mut bytes).unwrap();
    let part = engine.open(bytes).expect("PDFium should open the part");

    assert_eq!(part.signatures.count, 0);
    assert!(seal_pixels(engine, part.id) > 0);
    assert_eq!(
        annotation_types(engine, part.id),
        [PdfPageAnnotationType::Link]
    );

    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_a4_copy_of_a_signed_file_waits_for_the_answer_and_keeps_the_seal_if_drawn_in() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-a4");
    let kept = engine
        .open_from_path(source.clone())
        .expect("PDFium should open the signed file");

    assert_eq!(
        engine
            .fit_to_a4(kept.id, |_, _| {})
            .map(|document| document.map(|info| info.id)),
        Err(SIGNATURES_UNDECIDED_ERROR.to_string())
    );

    engine
        .decide_signatures(kept.id, SignatureDecision::Keep)
        .expect("the answer should be recorded");
    let copy = engine
        .fit_to_a4(kept.id, |_, _| {})
        .expect("PDFium should fit the page")
        .expect("nobody stopped it");
    assert_eq!(
        seal_pixels(engine, copy.id),
        0,
        "an A4 fit leaves annotations behind, the seal with them"
    );

    let flattened = engine
        .open_from_path(source)
        .expect("PDFium should open the signed file again");
    engine
        .decide_signatures(flattened.id, SignatureDecision::Flatten)
        .expect("the answer should be recorded");
    let copy = engine
        .fit_to_a4(flattened.id, |_, _| {})
        .expect("PDFium should fit the page")
        .expect("nobody stopped it");
    assert!(seal_pixels(engine, copy.id) > 0);
    assert_eq!(copy.signatures.count, 0);

    fs::remove_dir_all(&directory).ok();
}

// An invisible signature's widget may sit on no page; the form still lists
// the field, and with it a signature the flatten promised to remove.
#[test]
fn a_flatten_removes_a_signed_field_no_page_shows() {
    let bytes = build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /SigFlags 3 >> >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string(),
        "5 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T (Hidden) /Rect [0 0 0 0] /V 6 0 R >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 0 0 0] /Contents <00> >>\nendobj\n".to_string(),
    ]);

    let flattened = flatten_signatures(&bytes)
        .expect("the fixture should be readable")
        .expect("the signed field should go");
    let document = lopdf::Document::load_mem(&flattened).expect("the output should be readable");
    let form = document
        .catalog()
        .unwrap()
        .get(b"AcroForm")
        .unwrap()
        .as_dict()
        .unwrap();

    assert!(form.get(b"Fields").unwrap().as_array().unwrap().is_empty());
    assert!(!form.has(b"SigFlags"));
    assert!(!flattened.windows(10).any(|window| window == b"/ByteRange"));
}

// A flatten that failed must not strand the document: until an answer acts in
// place, the reader may give another.
#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_answer_may_change_until_it_acts() {
    let engine = test_engine();
    let (directory, source) = signed_source("signatures-answer-again");
    let signed = engine
        .open_from_path(source)
        .expect("PDFium should open the signed PDF");

    engine
        .decide_signatures(signed.id, SignatureDecision::Flatten)
        .expect("the answer should be recorded");
    let changed = engine
        .decide_signatures(signed.id, SignatureDecision::Keep)
        .expect("the answer should be recorded");
    assert_eq!(changed.decision, Some(SignatureDecision::Keep));
    engine
        .rotate_pages(signed.id, &[1], 90)
        .expect("kept signatures let the edit through");

    fs::remove_dir_all(&directory).ok();
}
