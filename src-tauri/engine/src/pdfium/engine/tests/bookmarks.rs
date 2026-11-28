use std::io::Read;
use zip::ZipArchive;

use super::support::*;
use super::*;
use crate::pdfium::archive::ArchiveOptions;
use crate::pdfium::compress::CompressionOptions;

fn nested_bookmarks_pdf() -> Vec<u8> {
    archive_bookmarks_pdf()
}

fn outline_summary(items: &[PdfOutlineItem]) -> Vec<(String, Option<i32>, usize)> {
    items
        .iter()
        .map(|item| (item.title.clone(), item.page_number, item.items.len()))
        .collect()
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn single_file_bookmarks_can_be_renamed_deleted_and_undone_and_persist_on_save() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-single-save");
    let path = directory.join("doc.pdf");
    fs::write(&path, nested_bookmarks_pdf()).expect("should write fixture");

    let opened = engine
        .open_from_path(path.clone())
        .expect("should open fixture");
    assert_eq!(opened.outline.len(), 3);

    // Rejects invalid paths and empty or overly long titles without creating pending edits.
    assert!(engine
        .rename_bookmark(opened.id, None, &[], "Name", false)
        .is_err());
    assert!(engine
        .rename_bookmark(opened.id, None, &[9], "Name", false)
        .is_err());
    assert!(engine.delete_bookmark(opened.id, None, &[9], 9).is_err());
    {
        let documents = engine.lock_documents().expect("documents lock");
        assert!(
            documents
                .get(&opened.id)
                .expect("open document")
                .outline_edits
                .is_none(),
            "rejected edits before any valid mutation must leave outline_edits unset"
        );
    }
    assert!(engine
        .rename_bookmark(opened.id, None, &[0], "   ", false)
        .is_err());
    let long = "a".repeat(513);
    assert!(engine
        .rename_bookmark(opened.id, None, &[0], &long, false)
        .is_err());

    // Rename with non-ASCII (CJK) characters and nested child path.
    let renamed = engine
        .rename_bookmark(opened.id, None, &[1, 0], "  第一章·序言  ", false)
        .expect("should rename nested bookmark");
    assert_eq!(renamed.outline[1].items[0].title, "第一章·序言");
    assert_eq!(renamed.outline[1].items[0].page_number, Some(2));

    // Exact restore preserves surrounding whitespace as undo would send it.
    let restored_exact = engine
        .rename_bookmark(opened.id, None, &[1, 0], "  第一章·序言  ", true)
        .expect("exact undo restore should preserve whitespace");
    assert_eq!(restored_exact.outline[1].items[0].title, "  第一章·序言  ");
    engine
        .rename_bookmark(opened.id, None, &[1, 0], "第一章·序言", false)
        .expect("normalize title back for downstream assertions");

    // Delete the first top-level bookmark, then save and reopen.
    let deleted = engine
        .delete_bookmark(opened.id, None, &[0], 10)
        .expect("should delete top-level bookmark");
    assert_eq!(
        outline_summary(&deleted.outline),
        vec![
            ("Part/one".to_string(), Some(1), 1),
            ("Duplicate".to_string(), Some(1), 0),
        ]
    );
    assert_eq!(deleted.outline[0].items[0].title, "第一章·序言");

    engine.save(opened.id).expect("save should persist edits");

    let reopened = engine
        .open_from_path(path.clone())
        .expect("should reopen saved file");
    assert_eq!(
        outline_summary(&reopened.outline),
        vec![
            ("Part/one".to_string(), Some(1), 1),
            ("Duplicate".to_string(), Some(1), 0),
        ]
    );
    assert_eq!(reopened.outline[0].items[0].title, "第一章·序言");
    assert_eq!(reopened.outline[0].items[0].page_number, Some(2));
    engine.close(reopened.id).ok();

    // Restore deleted bookmark via stash and delete a parent with children.
    let restored = engine
        .restore_bookmark(opened.id, 10)
        .expect("restore should put bookmark back");
    assert_eq!(restored.outline.len(), 3);
    assert_eq!(restored.outline[0].title, "Part/one");

    let deleted_parent = engine
        .delete_bookmark(opened.id, None, &[1], 11)
        .expect("should delete parent bookmark");
    assert_eq!(deleted_parent.outline.len(), 2);

    // Delete the remaining two bookmarks so /Outlines is removed entirely.
    engine
        .delete_bookmark(opened.id, None, &[1], 12)
        .expect("should delete remaining bookmark 2");
    let empty = engine
        .delete_bookmark(opened.id, None, &[0], 13)
        .expect("should delete last bookmark");
    assert!(empty.outline.is_empty());
    assert!(!empty.splits_by_bookmarks);

    engine.save(opened.id).expect("save with empty outline");
    let reopened_empty = engine
        .open_from_path(path)
        .expect("should reopen empty outline file");
    assert!(reopened_empty.outline.is_empty());
    assert!(!reopened_empty.splits_by_bookmarks);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn single_file_bookmark_edits_flow_to_exports_a4_compress_split_and_relink() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-exports");
    let opened = engine
        .open(nested_bookmarks_pdf())
        .expect("should open fixture");

    engine
        .rename_bookmark(opened.id, None, &[0], "Renamed First", false)
        .expect("rename should succeed");
    engine
        .delete_bookmark(opened.id, None, &[2], 20)
        .expect("delete should succeed");

    // Export (Save As) preserves edited outline.
    let exported_path = directory.join("exported.pdf");
    engine
        .export_to(opened.id, &exported_path)
        .expect("export should succeed");
    let reopened = engine
        .open_from_path(exported_path)
        .expect("should open exported");
    assert_eq!(
        outline_summary(&reopened.outline),
        vec![
            ("Renamed First".to_string(), Some(3), 0),
            ("Part/one".to_string(), Some(1), 1),
        ]
    );
    engine.close(reopened.id).ok();

    // Compressed copy preserves edited outline.
    let compressed_path = directory.join("compressed.pdf");
    engine
        .export_compressed(
            opened.id,
            &compressed_path,
            CompressionOptions { image_quality: 100 },
            |_, _| {},
        )
        .expect("compress should succeed");
    let compressed = engine
        .open_from_path(compressed_path)
        .expect("should open compressed");
    assert_eq!(
        outline_summary(&compressed.outline),
        vec![
            ("Renamed First".to_string(), Some(3), 0),
            ("Part/one".to_string(), Some(1), 1),
        ]
    );
    engine.close(compressed.id).ok();

    // A4 copy preserves edited outline.
    let a4 = engine
        .fit_to_a4(opened.id, |_, _| {})
        .expect("fit_to_a4 should succeed")
        .expect("should not cancel");
    assert_eq!(
        outline_summary(&a4.document.outline),
        vec![
            ("Renamed First".to_string(), Some(3), 0),
            ("Part/one".to_string(), Some(1), 1),
        ]
    );
    engine.close(a4.document.id).ok();

    // Split by bookmarks uses the renamed bookmark title for its archive entry.
    let zip_path = directory.join("split.zip");
    engine
        .export_archive(opened.id, &zip_path, ArchiveOptions::Bookmarks, |_, _| {})
        .expect("split should succeed");
    let mut archive =
        ZipArchive::new(fs::File::open(&zip_path).expect("zip should open")).expect("valid zip");
    let names: Vec<_> = (0..archive.len())
        .map(|i| {
            let mut f = archive.by_index(i).unwrap();
            let mut buf = Vec::new();
            let _ = f.read_to_end(&mut buf);
            f.name().expect("zip entry name").to_string()
        })
        .collect();
    assert!(
        names.iter().any(|name| name.contains("Renamed First")),
        "expected Renamed First in {names:?}"
    );

    // Deleting a targeted page and undoing it still relinks the renamed bookmark.
    let after_del = engine
        .delete_pages(opened.id, &[3], 30)
        .expect("delete page 3");
    assert_eq!(after_del.outline[0].title, "Renamed First");
    assert_eq!(after_del.outline[0].page_number, None);
    let after_undo = engine.restore_pages(opened.id, 30).expect("restore page 3");
    assert_eq!(after_undo.outline[0].title, "Renamed First");
    assert_eq!(after_undo.outline[0].page_number, Some(3));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn signed_document_requires_signature_decision_before_editing_bookmarks() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-signed");
    let signed_path = directory.join("signed.pdf");
    fs::write(&signed_path, signed_pdf()).expect("write signed fixture");

    let opened = engine
        .open_from_path(signed_path)
        .expect("open signed fixture");
    assert!(opened.signatures.intact);
    assert_eq!(opened.outline.len(), 1);

    let refused = engine
        .rename_bookmark(opened.id, None, &[0], "Tampered", false)
        .expect_err("undecided signed doc must refuse bookmark rename");
    assert_eq!(
        refused,
        super::super::signatures::SIGNATURES_UNDECIDED_ERROR
    );

    engine
        .decide_signatures(opened.id, SignatureDecision::Keep)
        .expect("decide signatures");
    let renamed = engine
        .rename_bookmark(opened.id, None, &[0], "Signed Section", false)
        .expect("decided doc allows rename");
    assert_eq!(renamed.outline[0].title, "Signed Section");

    // Original signed file still cannot be overwritten.
    assert!(engine.save(opened.id).is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn multi_file_section_bookmarks_can_be_renamed_deleted_and_restored() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-sections");
    let own = engine
        .open(outlined_three_page_pdf())
        .expect("open own pdf");

    let added_path = directory.join("added.pdf");
    fs::write(&added_path, nested_bookmarks_pdf()).expect("write added pdf");
    let ids = engine
        .read_sources("bookmarks-sections", vec![added_path], false)
        .expect("read sources")
        .into_iter()
        .map(|info| info.id.expect("valid id"))
        .collect::<Vec<_>>();

    let merged = engine
        .insert_sources(
            "bookmarks-sections",
            own.id,
            &ids,
            4,
            "own.pdf",
            FileOptions {
                smart_padding: false,
            },
            &HashMap::new(),
        )
        .expect("insert sources");
    assert_eq!(merged.sections.len(), 2);

    // Rename bookmark in section 0 and section 1, and delete one in section 1.
    let u1 = engine
        .rename_bookmark(own.id, Some(0), &[0], "Own Chapter Renamed", false)
        .expect("rename section 0 bookmark");
    assert_eq!(u1.sections[0].outline[0].title, "Own Chapter Renamed");

    let u2 = engine
        .rename_bookmark(own.id, Some(1), &[1, 0], "Child Renamed", false)
        .expect("rename section 1 nested bookmark");
    assert_eq!(u2.sections[1].outline[1].items[0].title, "Child Renamed");

    let u3 = engine
        .delete_bookmark(own.id, Some(1), &[0], 40)
        .expect("delete section 1 bookmark");
    assert_eq!(u3.sections[1].outline.len(), 2);

    // Export writes the edited section bookmarks.
    let out_path = directory.join("combined.pdf");
    engine
        .export_to(own.id, &out_path)
        .expect("export combined");
    let reopened = engine.open_from_path(out_path).expect("reopen combined");
    assert_eq!(reopened.outline[0].items[0].title, "Own Chapter Renamed");
    assert_eq!(reopened.outline[1].items.len(), 2);
    assert_eq!(reopened.outline[1].items[0].items[0].title, "Child Renamed");
    engine.close(reopened.id).ok();

    // Restore deleted bookmark in section 1.
    let u4 = engine
        .restore_bookmark(own.id, 40)
        .expect("restore section 1 bookmark");
    assert_eq!(u4.sections[1].outline.len(), 3);

    // Delete added file pages -> back to single file, keeping section 0's rename!
    let back_to_one = engine
        .delete_pages(own.id, &[4, 5, 6], 41)
        .expect("delete added pages");
    assert_eq!(back_to_one.outline[0].title, "Own Chapter Renamed");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn bookmarks_can_be_added_to_empty_and_existing_outlines_and_follow_page_moves() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-add");

    // Adding a bookmark to a PDF with no /Outlines creates one on save and export.
    let blank_path = directory.join("no-outline.pdf");
    let created = engine.create_blank().expect("create blank doc");
    engine
        .insert_blank_page(created.id, 2, None)
        .expect("insert page 2");
    engine
        .insert_blank_page(created.id, 3, None)
        .expect("insert page 3");
    engine
        .export_to(created.id, &blank_path)
        .expect("save blank 3-page doc");
    engine.close(created.id).ok();

    let empty_doc = engine
        .open_from_path(blank_path.clone())
        .expect("open 3-page doc");
    assert!(empty_doc.outline.is_empty());
    assert!(!empty_doc.splits_by_bookmarks);

    // Rejects invalid path, page number, and blank or overlong title without creating edits.
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[], 1, "Cover")
        .is_err());
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[1], 1, "Out of range")
        .is_err());
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[0], 0, "Zero")
        .is_err());
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[0], 4, "Past end")
        .is_err());
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[0], 1, "   ")
        .is_err());
    assert!(engine
        .add_bookmark(empty_doc.id, None, &[0], 1, &"a".repeat(513))
        .is_err());

    let added = engine
        .add_bookmark(empty_doc.id, None, &[0], 2, "  第二页书签  ")
        .expect("add bookmark on page 2");
    assert_eq!(
        outline_summary(&added.outline),
        vec![("第二页书签".to_string(), Some(2), 0)]
    );
    assert!(added.splits_by_bookmarks);

    // Reordering page 2 to page 3 moves the added bookmark with its page.
    let reordered = engine
        .reorder_pages(empty_doc.id, &[1, 3, 2], None)
        .expect("reorder pages");
    assert_eq!(reordered.outline[0].page_number, Some(3));

    // Deleting the targeted page and undoing it restores the bookmark's destination.
    let after_del = engine
        .delete_pages(empty_doc.id, &[3], 50)
        .expect("delete page 3");
    assert_eq!(after_del.outline[0].page_number, None);
    let after_restore = engine
        .restore_pages(empty_doc.id, 50)
        .expect("restore page 3");
    assert_eq!(after_restore.outline[0].page_number, Some(3));

    // Save persists newly created /Outlines onto disk, and compress / A4 carry it too.
    engine.save(empty_doc.id).expect("save with new outline");
    let reopened = engine.open_from_path(blank_path).expect("reopen saved doc");
    assert_eq!(
        outline_summary(&reopened.outline),
        vec![("第二页书签".to_string(), Some(3), 0)]
    );
    engine.close(reopened.id).ok();

    let compressed_path = directory.join("compressed-added.pdf");
    engine
        .export_compressed(
            empty_doc.id,
            &compressed_path,
            CompressionOptions { image_quality: 100 },
            |_, _| {},
        )
        .expect("compress with added bookmark");
    let compressed = engine
        .open_from_path(compressed_path)
        .expect("open compressed");
    assert_eq!(
        outline_summary(&compressed.outline),
        vec![("第二页书签".to_string(), Some(3), 0)]
    );
    engine.close(compressed.id).ok();

    let a4 = engine
        .fit_to_a4(empty_doc.id, |_, _| {})
        .expect("fit_to_a4")
        .expect("not cancelled");
    assert_eq!(
        outline_summary(&a4.document.outline),
        vec![("第二页书签".to_string(), Some(3), 0)]
    );
    engine.close(a4.document.id).ok();

    // remove_bookmark undoes add_bookmark cleanly without creating a stash.
    let removed = engine
        .remove_bookmark(empty_doc.id, None, &[0])
        .expect("remove added bookmark");
    assert!(removed.outline.is_empty());
    {
        let documents = engine.lock_documents().expect("documents lock");
        assert!(documents
            .get(&empty_doc.id)
            .expect("open doc")
            .bookmark_stashes
            .is_empty());
    }
    engine.close(empty_doc.id).ok();

    // Adding a child bookmark inside an existing nested outline preserves existing bookmarks.
    let nested = engine
        .open(nested_bookmarks_pdf())
        .expect("open nested outline fixture");
    let with_child = engine
        .add_bookmark(nested.id, None, &[1, 1], 3, "Inserted Child")
        .expect("add nested child");
    assert_eq!(with_child.outline[1].items.len(), 2);
    assert_eq!(with_child.outline[1].items[1].title, "Inserted Child");
    assert_eq!(with_child.outline[1].items[1].page_number, Some(3));

    let nested_out = directory.join("nested-added.pdf");
    engine
        .export_to(nested.id, &nested_out)
        .expect("export nested with added child");
    let reopened_nested = engine.open_from_path(nested_out).expect("reopen nested");
    assert_eq!(reopened_nested.outline[1].items.len(), 2);
    assert_eq!(reopened_nested.outline[1].items[0].page_number, Some(2));
    assert_eq!(reopened_nested.outline[1].items[1].title, "Inserted Child");
    assert_eq!(reopened_nested.outline[1].items[1].page_number, Some(3));
    engine.close(reopened_nested.id).ok();
    engine.close(nested.id).ok();

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn multi_file_section_bookmarks_can_be_added_and_enforced_per_section() {
    let engine = test_engine();
    let directory = scratch_directory("bookmarks-add-sections");
    let own = engine
        .open(outlined_three_page_pdf())
        .expect("open own pdf");

    let added_path = directory.join("added.pdf");
    fs::write(&added_path, nested_bookmarks_pdf()).expect("write added pdf");
    let ids = engine
        .read_sources("bookmarks-add-sections", vec![added_path], false)
        .expect("read sources")
        .into_iter()
        .map(|info| info.id.expect("valid id"))
        .collect::<Vec<_>>();

    engine
        .insert_sources(
            "bookmarks-add-sections",
            own.id,
            &ids,
            4,
            "own.pdf",
            FileOptions {
                smart_padding: false,
            },
            &HashMap::new(),
        )
        .expect("insert sources");

    // Rejects adding a page that belongs to another section.
    assert!(engine
        .add_bookmark(own.id, Some(1), &[0], 1, "Wrong file")
        .is_err());

    // Add to section 0 and section 1.
    let u1 = engine
        .add_bookmark(own.id, Some(0), &[1], 2, "Own Added")
        .expect("add in section 0");
    assert_eq!(u1.sections[0].outline[1].title, "Own Added");
    assert_eq!(u1.sections[0].outline[1].page_number, Some(2));

    let u2 = engine
        .add_bookmark(own.id, Some(1), &[3], 5, "Second File Added")
        .expect("add in section 1");
    assert_eq!(u2.sections[1].outline[3].title, "Second File Added");
    assert_eq!(u2.sections[1].outline[3].page_number, Some(5));

    // Export persists both sections' added bookmarks.
    let out_path = directory.join("combined-added.pdf");
    engine
        .export_to(own.id, &out_path)
        .expect("export combined");
    let reopened = engine.open_from_path(out_path).expect("reopen combined");
    assert_eq!(reopened.outline[0].items[1].title, "Own Added");
    assert_eq!(reopened.outline[0].items[1].page_number, Some(2));
    assert_eq!(reopened.outline[1].items[3].title, "Second File Added");
    assert_eq!(reopened.outline[1].items[3].page_number, Some(5));
    engine.close(reopened.id).ok();

    // Deleting added file returns to single file while keeping section 0's added bookmark.
    let back = engine
        .delete_pages(own.id, &[4, 5, 6], 60)
        .expect("delete added file");
    assert_eq!(back.outline[1].title, "Own Added");
    assert_eq!(back.outline[1].page_number, Some(2));

    fs::remove_dir_all(directory).ok();
}
