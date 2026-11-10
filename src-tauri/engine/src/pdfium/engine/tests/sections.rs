use super::support::*;
use super::*;

/// A window of its own: the organize tests release and evict theirs.
const SCOPE: &str = "sections";

/// Organize sources live in one registry for every window; tests that add
/// them run one at a time, as the organize tests do.
fn sections_test_guard() -> MutexGuard<'static, ()> {
    static GUARD: Mutex<()> = Mutex::new(());

    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_files(engine: &PdfiumEngine, paths: Vec<PathBuf>) -> Vec<u64> {
    engine
        .add_organize_sources(SCOPE, paths, false)
        .expect("the files should be read")
        .into_iter()
        .map(|info| info.id.expect("every file should be readable"))
        .collect()
}

fn write_file(directory: &Path, name: &str, bytes: Vec<u8>) -> PathBuf {
    let path = directory.join(name);

    fs::write(&path, bytes).expect("the file should write to disk");
    path
}

fn sections_of(update: &PdfStructureUpdate) -> Vec<(u64, String)> {
    update
        .sections
        .iter()
        .map(|section| (section.id, section.title.clone()))
        .collect()
}

fn page_sections(update: &PdfStructureUpdate) -> Vec<Option<u64>> {
    update.pages.iter().map(|page| page.section).collect()
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn added_files_land_before_the_index_each_a_file_of_its_own() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-insert");
    let own = engine
        .open(outlined_three_page_pdf())
        .expect("PDFium should open the document");
    let added = banded_pdf(&[20, 60]);
    let added_prints = {
        let opened = engine
            .open(added.clone())
            .expect("PDFium should open the file");

        page_fingerprints(engine, opened.id, 2)
    };
    let ids = read_files(
        engine,
        vec![
            write_file(&directory, "added.pdf", added),
            write_file(&directory, "outlined.pdf", outlined_three_page_pdf()),
        ],
    );

    let update = engine
        .insert_organize_sources(SCOPE, own.id, &ids, 2, "own.pdf", true, None)
        .expect("the files should be added");

    assert_eq!(update.num_pages, 8);
    assert!(update.has_foreign_pages);
    assert_eq!(
        sections_of(&update),
        vec![
            (0, "own.pdf".to_string()),
            (1, "added.pdf".to_string()),
            (2, "outlined.pdf".to_string()),
        ]
    );
    assert_eq!(
        page_sections(&update),
        vec![
            Some(0),
            Some(1),
            Some(1),
            Some(2),
            Some(2),
            Some(2),
            Some(0),
            Some(0)
        ]
    );
    // Each file's bookmark follows its page: the document's own chapter was
    // page 3 and is now page 8, the added copy's lands on its own page 3.
    assert_eq!(update.sections[0].outline[0].page_number, Some(8));
    assert_eq!(update.sections[2].outline[0].page_number, Some(6));
    assert_eq!(page_fingerprints(engine, own.id, 8)[1..3], added_prints[..]);
    // Consumed: the pages are the document's own copies now.
    assert!(engine
        .insert_organize_sources(SCOPE, own.id, &ids[..1], 1, "own.pdf", true, None)
        .is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_document_with_added_files_saves_only_as_a_new_file_with_a_bookmark_each() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-save");
    let own_path = write_file(&directory, "own.pdf", outlined_three_page_pdf());
    let own = engine
        .open_from_path(own_path.clone())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(&directory, "added.pdf", banded_pdf(&[20, 60]))],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 4, "own.pdf", true, None)
        .expect("the file should be added");

    let refused = engine
        .save(own.id)
        .expect_err("a save over the document's own file should be refused");
    assert!(refused.contains("new file"), "{refused}");

    let refused = engine
        .export_to(own.id, &own_path)
        .expect_err("a Save As over the document's own file should be refused");
    assert_eq!(refused, io::EXPORT_COPY_ONLY_ERROR);

    let combined = directory.join("combined.pdf");
    let outcome = engine
        .export_to(own.id, &combined)
        .expect("a Save As should write the combined document");
    assert!(outcome.saved_to_source());

    let reopened = engine
        .open_from_path(combined)
        .expect("the combined file should open");
    let titles: Vec<_> = reopened
        .outline
        .iter()
        .map(|item| (item.title.clone(), item.page_number))
        .collect();

    assert_eq!(
        titles,
        vec![
            ("own.pdf".to_string(), Some(1)),
            ("added.pdf".to_string(), Some(4)),
        ]
    );
    assert_eq!(reopened.outline[0].items[0].title, "Chapter");
    assert_eq!(reopened.outline[0].items[0].page_number, Some(3));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn without_a_bookmark_per_file_the_files_bookmarks_follow_one_another() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-flat");
    let own = engine
        .open(outlined_three_page_pdf())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(
            &directory,
            "second.pdf",
            outlined_three_page_pdf(),
        )],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 4, "own.pdf", false, None)
        .expect("the file should be added");

    let combined = directory.join("flat.pdf");
    engine
        .export_to(own.id, &combined)
        .expect("a Save As should write the combined document");
    let reopened = engine
        .open_from_path(combined)
        .expect("the combined file should open");
    let titles: Vec<_> = reopened
        .outline
        .iter()
        .map(|item| (item.title.clone(), item.page_number))
        .collect();

    assert_eq!(
        titles,
        vec![
            ("Chapter".to_string(), Some(3)),
            ("Chapter".to_string(), Some(6)),
        ]
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_undone_insert_lets_the_file_save_again_and_a_redo_brings_its_files_back() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-undo");
    let own_path = write_file(&directory, "own.pdf", two_page_pdf());
    let own = engine
        .open_from_path(own_path)
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(
            &directory,
            "added.pdf",
            banded_pdf(&[20, 60, 100]),
        )],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", true, None)
        .expect("the file should be added");

    // The undo of an insert deletes its run under the entry's stash.
    let undone = engine
        .delete_pages(own.id, &[3, 4, 5], 7)
        .expect("the added pages should go");
    assert!(!undone.has_foreign_pages);
    assert!(undone.sections.is_empty());
    engine
        .save(own.id)
        .expect("the file alone saves over itself again");

    let redone = engine
        .restore_pages(own.id, 7)
        .expect("the redo should bring the pages back");
    assert!(redone.has_foreign_pages);
    assert_eq!(redone.sections.len(), 2);
    assert_eq!(
        page_sections(&redone),
        vec![Some(0), Some(0), Some(1), Some(1), Some(1)]
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn pages_move_between_files_by_the_layout_and_new_ones_join_the_file_named() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-layout");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(&directory, "added.pdf", banded_pdf(&[20, 60]))],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", true, None)
        .expect("the file should be added");

    // Page 1 dropped between the added file's two pages joins that file.
    let moved = engine
        .reorder_pages(own.id, &[2, 3, 1, 4], Some(&[0, 1, 1, 1]))
        .expect("the reorder should land");
    assert_eq!(
        page_sections(&moved),
        vec![Some(0), Some(1), Some(1), Some(1)]
    );
    assert!(engine
        .reorder_pages(own.id, &[1, 2, 3, 4], Some(&[0, 1]))
        .is_err());
    assert!(engine
        .reorder_pages(own.id, &[1, 2, 3, 4], Some(&[0, 9, 1, 1]))
        .is_err());

    let blank = engine
        .insert_blank_page(own.id, 2, Some(1))
        .expect("the blank page should land");
    assert_eq!(page_sections(&blank)[1], Some(1));

    // Unnamed, a new page joins the file before it.
    let defaulted = engine
        .insert_blank_page(own.id, 6, None)
        .expect("the blank page should land");
    assert_eq!(page_sections(&defaulted)[5], Some(1));
    assert!(engine.insert_blank_page(own.id, 1, Some(9)).is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_copy_of_an_added_page_is_still_another_file_s() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-copy");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(&directory, "added.pdf", banded_pdf(&[20]))],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", true, None)
        .expect("the file should be added");
    engine
        .duplicate_pages(own.id, &[3], 1, Some(0))
        .expect("the copy should land");

    // The original goes; the copy keeps the document from its own file.
    let left = engine
        .delete_pages(own.id, &[4], 3)
        .expect("the original should go");
    assert!(left.has_foreign_pages);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_file_takes_a_new_name_but_never_an_empty_one() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-rename");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(&directory, "added.pdf", banded_pdf(&[20]))],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", true, None)
        .expect("the file should be added");

    let renamed = engine
        .rename_section(own.id, 1, "  Appendix  ")
        .expect("the rename should land");
    assert_eq!(renamed.sections[1].title, "Appendix");
    assert!(engine.rename_section(own.id, 1, "   ").is_err());
    assert!(engine.rename_section(own.id, 9, "Other").is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_signed_file_is_added_only_once_its_signatures_are_answered_for() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-signed");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let signed_path = write_file(&directory, "signed.pdf", signed_pdf());
    let ids = read_files(engine, vec![signed_path.clone()]);

    assert!(engine
        .insert_organize_sources(SCOPE, own.id, &ids, 1, "own.pdf", true, None)
        .is_err());

    let added = engine
        .insert_organize_sources(
            SCOPE,
            own.id,
            &ids,
            1,
            "own.pdf",
            true,
            Some(SignatureDecision::Flatten),
        )
        .expect("the answered file should be added");
    assert_eq!(added.num_pages, 3);

    // Its source is released, yet the signed file stays out of every write.
    let refused = engine
        .export_to(own.id, &signed_path)
        .expect_err("a Save As over the signed file should be refused");
    assert_eq!(refused, super::super::signatures::EXPORT_SIGNED_ERROR);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_added_file_left_alone_keeps_its_bookmarks_in_a_save_as() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-left-alone");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let ids = read_files(
        engine,
        vec![write_file(
            &directory,
            "outlined.pdf",
            outlined_three_page_pdf(),
        )],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", false, None)
        .expect("the file should be added");

    let left = engine
        .delete_pages(own.id, &[1, 2], 7)
        .expect("the document's own pages should go");
    assert!(left.sections.is_empty());
    assert!(left.has_foreign_pages);

    let saved = directory.join("left.pdf");
    engine
        .export_to(own.id, &saved)
        .expect("a Save As should write what is left");
    let reopened = engine
        .open_from_path(saved)
        .expect("the written file should open");
    let titles: Vec<_> = reopened
        .outline
        .iter()
        .map(|item| (item.title.clone(), item.page_number))
        .collect();

    assert_eq!(titles, vec![("Chapter".to_string(), Some(3))]);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_file_that_cannot_be_added_leaves_the_document_as_it_was() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-rollback");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let changing = write_file(&directory, "changing.pdf", banded_pdf(&[20]));
    let ids = read_files(
        engine,
        vec![
            write_file(&directory, "steady.pdf", banded_pdf(&[60])),
            changing.clone(),
        ],
    );

    // Let the second go from memory, then change it on disk.
    engine.evict_organize_sources_for_test(SCOPE);
    fs::write(&changing, banded_pdf(&[20, 60])).expect("the file should change");

    let refused = engine
        .insert_organize_sources(SCOPE, own.id, &ids, 3, "own.pdf", true, None)
        .expect_err("a changed file should be refused");
    assert!(refused.contains(ORGANIZE_SOURCE_CHANGED), "{refused}");

    let after = engine
        .rotate_pages(own.id, &[1], 0)
        .expect("the document should still answer");
    assert_eq!(after.num_pages, 2);
    assert!(!after.has_foreign_pages);
    assert!(after.sections.is_empty());
    assert!(page_sections(&after).iter().all(Option::is_none));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_document_back_to_one_file_adds_the_next_under_the_name_it_has_now() {
    let _guard = sections_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("sections-resume");
    let own = engine
        .open(two_page_pdf())
        .expect("PDFium should open the document");
    let first = read_files(
        engine,
        vec![write_file(&directory, "first.pdf", banded_pdf(&[20]))],
    );

    engine
        .insert_organize_sources(SCOPE, own.id, &first, 3, "own.pdf", true, None)
        .expect("the file should be added");
    engine
        .delete_pages(own.id, &[3], 5)
        .expect("the undo should take the file out");

    let second = read_files(
        engine,
        vec![write_file(&directory, "second.pdf", banded_pdf(&[60]))],
    );
    let added = engine
        .insert_organize_sources(SCOPE, own.id, &second, 3, "renamed.pdf", true, None)
        .expect("the next file should be added");

    assert_eq!(
        sections_of(&added),
        vec![
            (0, "renamed.pdf".to_string()),
            (2, "second.pdf".to_string())
        ]
    );

    fs::remove_dir_all(directory).ok();
}
