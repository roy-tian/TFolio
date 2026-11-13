//! Pages copied between documents must keep nothing aimed at the document
//! they came from: once it closes, PDFium's next save of the copy would
//! follow that pointer into freed memory and take the app down with it.

use super::support::*;
use super::*;

/// A stamp on page 1 whose pop-up names it as `/Parent`, as a reviewer's seal
/// leaves one: a key FPDF_ImportPages copies without rewriting.
fn popup_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R 5 0 R] >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Annot /Subtype /Stamp /Rect [10 10 60 60] /Contents (Seal) /Popup 5 0 R /P 3 0 R >>\nendobj\n".to_string(),
        "5 0 obj\n<< /Type /Annot /Subtype /Popup /Rect [70 10 170 60] /Parent 4 0 R /P 3 0 R >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n".to_string(),
    ])
}

/// Two links on page 1 sharing one indirect destination on page 2. PDFium
/// copies page 1 first, gives the first link's destination up half-copied
/// while page 2 is not yet in, and hands the second link that half-copy.
fn shared_forward_destination_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [6 0 R 7 0 R] >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n".to_string(),
        "5 0 obj\n[4 0 R /XYZ 0 0 0]\nendobj\n".to_string(),
        "6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Dest 5 0 R >>\nendobj\n".to_string(),
        "7 0 obj\n<< /Type /Annot /Subtype /Link /Rect [60 0 110 50] /Dest 5 0 R >>\nendobj\n".to_string(),
    ])
}

/// Reuses the memory closed documents left, so a pointer still aimed into
/// one fails on the next save rather than only when the heap happens to.
fn churn(engine: &PdfiumEngine) {
    for _ in 0..50 {
        let scratch = engine
            .open(banded_pdf(&[20, 40, 60]))
            .expect("PDFium should open the scratch document");

        engine.close(scratch.id).expect("the scratch should close");
    }
}

/// Moves the first page last, which snapshots the document through a save.
fn rotate_order(engine: &PdfiumEngine, document_id: u64, page_count: i32) {
    let order: Vec<i32> = (2..=page_count).chain([1]).collect();

    engine
        .reorder_pages(document_id, &order, None)
        .expect("the reorder should save its snapshot");
}

/// A radio field on page 1 of two, its buttons kid widgets naming it as
/// `/Parent`: the field itself lives only in `/AcroForm`.
fn radio_form_pdf() -> Vec<u8> {
    build_pdf(&[
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>\nendobj\n".to_string(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_string(),
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [6 0 R 7 0 R] >>\nendobj\n".to_string(),
        "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n".to_string(),
        "5 0 obj\n<< /FT /Btn /Ff 49152 /T (choice) /V /A /Kids [6 0 R 7 0 R] >>\nendobj\n".to_string(),
        "6 0 obj\n<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [10 10 30 30] /AS /A >>\nendobj\n".to_string(),
        "7 0 obj\n<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [40 10 60 30] /AS /Off >>\nendobj\n".to_string(),
    ])
}

/// The document's Save As, read back.
fn saved(engine: &PdfiumEngine, document_id: u64, label: &str) -> lopdf::Document {
    let directory = scratch_directory(label);
    let path = directory.join("saved.pdf");

    engine
        .export_to(document_id, &path)
        .expect("the Save As should write");

    let saved = lopdf::Document::load(&path).expect("the Save As should read back");

    fs::remove_dir_all(directory).ok();
    saved
}

/// The annotations of `subtype` on the document's pages, a field's `/Kids`
/// still naming the ones a delete took off aside.
fn annotations<'a>(
    document: &'a lopdf::Document,
    subtype: &'a [u8],
) -> impl Iterator<Item = &'a lopdf::Dictionary> {
    document
        .get_pages()
        .into_values()
        .filter_map(|page| document.get_dictionary(page).ok())
        .filter_map(|page| page.get(b"Annots").ok())
        .filter_map(|annots| document.dereference(annots).ok())
        .filter_map(|(_, annots)| annots.as_array().ok())
        .flatten()
        .filter_map(|annot| document.dereference(annot).ok())
        .filter_map(|(_, annot)| annot.as_dict().ok())
        .filter(move |dict| {
            dict.get(b"Subtype")
                .and_then(lopdf::Object::as_name)
                .is_ok_and(|name| name == subtype)
        })
}

/// Each pop-up in the document's Save As, by whether it still names a parent.
fn saved_popup_parents(engine: &PdfiumEngine, document_id: u64, label: &str) -> Vec<bool> {
    annotations(&saved(engine, document_id, label), b"Popup")
        .map(|dict| dict.has(b"Parent"))
        .collect()
}

/// The name of the field each widget in the document's Save As belongs to.
fn saved_widget_fields(
    engine: &PdfiumEngine,
    document_id: u64,
    label: &str,
) -> Vec<Option<String>> {
    let saved = saved(engine, document_id, label);

    annotations(&saved, b"Widget")
        .map(|widget| {
            let field = widget.get(b"Parent").ok()?.as_reference().ok()?;
            let name = saved.get_dictionary(field).ok()?.get(b"T").ok()?;

            Some(String::from_utf8_lossy(name.as_str().ok()?).into_owned())
        })
        .collect()
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_added_file_s_popups_leave_nothing_aimed_at_it() {
    let engine = test_engine();
    let directory = scratch_directory("import-added-file");
    let path = directory.join("sealed.pdf");

    fs::write(&path, popup_pdf()).expect("the source should write");

    let ids: Vec<u64> = engine
        .read_sources("import-added-file", vec![path], false)
        .expect("the source should be read")
        .into_iter()
        .map(|info| info.id.expect("the source should be readable"))
        .collect();
    let document = engine
        .open(banded_pdf(&[100]))
        .expect("PDFium should open the document");
    let options = FileOptions {
        smart_padding: false,
        per_file_bookmarks: false,
    };

    // The source goes once its pages are in.
    engine
        .insert_sources(
            "import-added-file",
            document.id,
            &ids,
            2,
            "own.pdf",
            options,
            &HashMap::new(),
        )
        .expect("the file should be added");
    churn(engine);
    rotate_order(engine, document.id, 3);

    assert_eq!(
        saved_popup_parents(engine, document.id, "import-added-file-saved"),
        vec![false],
        "the pop-up comes along, without the parent PDFium cannot aim at its copy",
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn pages_from_a_closed_tab_still_save() {
    let engine = test_engine();
    let source = engine
        .open(popup_pdf())
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[20]))
        .expect("PDFium should open the target");

    engine
        .insert_pages_from_document(target.id, source.id, &[1], 2, None)
        .expect("the page should come across");
    engine.close(source.id).expect("the source should close");
    churn(engine);
    rotate_order(engine, target.id, 2);

    assert_eq!(
        saved_popup_parents(engine, target.id, "import-closed-tab"),
        vec![false]
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_deleted_page_restored_after_a_save_still_saves() {
    let engine = test_engine();
    let document = engine
        .open(popup_pdf())
        .expect("PDFium should open the document");
    let directory = scratch_directory("import-restore");

    engine
        .delete_pages(document.id, &[1], 1)
        .expect("the page should go to its stash");
    // A save after a delete reads the document back from its bytes.
    engine
        .save_to(document.id, &directory.join("saved.pdf"))
        .expect("the document should save");
    engine
        .restore_pages(document.id, 1)
        .expect("the undo should bring the page back");
    churn(engine);
    rotate_order(engine, document.id, 2);

    assert_eq!(
        saved_popup_parents(engine, document.id, "import-restore-saved"),
        vec![false]
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn links_sharing_a_destination_outlive_the_tab_they_came_from() {
    let engine = test_engine();
    let source = engine
        .open(shared_forward_destination_pdf())
        .expect("PDFium should open the source");
    let target = engine
        .open(banded_pdf(&[20]))
        .expect("PDFium should open the target");

    engine
        .insert_pages_from_document(target.id, source.id, &[1, 2], 2, None)
        .expect("the pages should come across");
    engine.close(source.id).expect("the source should close");
    churn(engine);
    rotate_order(engine, target.id, 3);
    saved_popup_parents(engine, target.id, "import-shared-destination");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn pasted_copies_of_links_sharing_a_destination_still_save() {
    let engine = test_engine();
    let document = engine
        .open(shared_forward_destination_pdf())
        .expect("PDFium should open the document");

    // The copies pass through a scratch document that closes with the paste.
    engine
        .duplicate_pages(document.id, &[1, 2], 3, None)
        .expect("the copies should land");
    churn(engine);
    rotate_order(engine, document.id, 4);
    saved_popup_parents(engine, document.id, "import-duplicate");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn widgets_keep_their_field_through_a_delete_s_undo_and_a_paste() {
    let engine = test_engine();
    let document = engine
        .open(radio_form_pdf())
        .expect("PDFium should open the form");
    let directory = scratch_directory("import-form-home");
    let choice = Some("choice".to_string());

    engine
        .delete_pages(document.id, &[1], 1)
        .expect("the page should go to its stash");
    engine
        .save_to(document.id, &directory.join("saved.pdf"))
        .expect("the document should save");
    engine
        .restore_pages(document.id, 1)
        .expect("the undo should bring the page back");

    assert_eq!(
        saved_widget_fields(engine, document.id, "import-form-restored"),
        vec![choice.clone(); 2],
        "the restored buttons still belong to their field",
    );

    engine
        .duplicate_pages(document.id, &[1], 3, None)
        .expect("the copy should land");

    assert_eq!(
        saved_widget_fields(engine, document.id, "import-form-pasted"),
        vec![choice; 4],
        "pasted buttons join the field their originals belong to",
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn widgets_carried_to_another_document_name_no_field_there() {
    let engine = test_engine();
    let source = engine
        .open(radio_form_pdf())
        .expect("PDFium should open the form");
    let target = engine
        .open(banded_pdf(&[20]))
        .expect("PDFium should open the target");

    engine
        .insert_pages_from_document(target.id, source.id, &[1], 2, None)
        .expect("the page should come across");
    engine.close(source.id).expect("the source should close");
    churn(engine);

    assert_eq!(
        saved_widget_fields(engine, target.id, "import-form-away"),
        vec![None, None],
        "the field stayed behind, so the buttons name none",
    );
}
