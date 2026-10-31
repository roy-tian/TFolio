use super::super::organize::{
    AssembleOutlineItem, AssemblePlan, AssembleSlot, ORGANIZE_SOURCE_CHANGED,
};
use super::support::*;
use super::*;

fn organize_test_guard() -> MutexGuard<'static, ()> {
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
        .add_organize_sources(scope, paths, false)
        .expect("the sources should be read")
        .into_iter()
        .map(|info| info.id.expect("every source should be readable"))
        .collect()
}

fn page(source_id: u64, page_number: i32, turn: i32) -> AssembleSlot {
    AssembleSlot::Page {
        source_id,
        page_number,
        turn,
    }
}

fn plan(slots: Vec<AssembleSlot>, outline: Vec<AssembleOutlineItem>) -> AssemblePlan {
    AssemblePlan {
        slots,
        normalize_a4: false,
        outline,
    }
}

fn opened_prints(engine: &PdfiumEngine, bytes: Vec<u8>, count: i32) -> Vec<Vec<u8>> {
    let opened = engine.open(bytes).expect("PDFium should open the file");

    page_fingerprints(engine, opened.id, count)
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_assembly_interleaves_pages_across_files_in_the_plan_s_order() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-interleave");
    let first = banded_pdf(&[20, 60]);
    let second = banded_pdf(&[110, 150, 190]);
    let first_prints = opened_prints(engine, first.clone(), 2);
    let second_prints = opened_prints(engine, second.clone(), 3);
    let ids = added(
        engine,
        "main",
        vec![
            write_source(&directory, "first.pdf", first),
            write_source(&directory, "second.pdf", second),
        ],
    );

    let assembled = engine
        .assemble_pdf(
            "main",
            plan(
                vec![
                    page(ids[1], 3, 0),
                    page(ids[0], 2, 0),
                    page(ids[1], 1, 0),
                    page(ids[0], 1, 0),
                ],
                Vec::new(),
            ),
            |_, _| {},
        )
        .expect("PDFium should assemble the pages")
        .expect("an assembly nobody stopped hands back its document");

    assert_eq!(assembled.num_pages, 4);
    assert!(
        assembled.path.is_none(),
        "an assembly has no file of its own"
    );
    assert_eq!(
        page_fingerprints(engine, assembled.id, 4),
        vec![
            second_prints[2].clone(),
            first_prints[1].clone(),
            second_prints[0].clone(),
            first_prints[0].clone(),
        ],
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_assembly_turns_pages_and_sizes_blanks_as_planned() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-turn-blank");
    let ids = added(
        engine,
        "main",
        vec![write_source(
            &directory,
            "source.pdf",
            banded_pdf(&[20, 60]),
        )],
    );

    let assembled = engine
        .assemble_pdf(
            "main",
            plan(
                vec![
                    page(ids[0], 1, 90),
                    AssembleSlot::Blank {
                        width: 400.0,
                        height: 250.0,
                    },
                    page(ids[0], 2, 0),
                ],
                Vec::new(),
            ),
            |_, _| {},
        )
        .expect("PDFium should assemble the pages")
        .expect("an assembly nobody stopped hands back its document");

    let sizes: Vec<_> = assembled
        .pages
        .iter()
        .map(|page| (page.width.round(), page.height.round(), page.rotation))
        .collect();

    assert_eq!(
        sizes,
        vec![
            (300.0, 200.0, 90.0),
            (400.0, 250.0, 0.0),
            (200.0, 300.0, 0.0)
        ],
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_assembly_writes_the_outline_it_is_given() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-outline");
    let ids = added(
        engine,
        "main",
        vec![write_source(
            &directory,
            "source.pdf",
            banded_pdf(&[20, 60, 100]),
        )],
    );
    let outline = vec![AssembleOutlineItem {
        title: "Part".into(),
        page_number: 1,
        items: vec![AssembleOutlineItem {
            title: "Late".into(),
            page_number: 3,
            items: Vec::new(),
        }],
    }];

    let assembled = engine
        .assemble_pdf(
            "main",
            plan(
                vec![page(ids[0], 3, 0), page(ids[0], 1, 0), page(ids[0], 2, 0)],
                outline,
            ),
            |_, _| {},
        )
        .expect("PDFium should assemble the pages")
        .expect("an assembly nobody stopped hands back its document");

    assert_eq!(assembled.outline.len(), 1);
    assert_eq!(assembled.outline[0].title, "Part");
    assert_eq!(assembled.outline[0].page_number, Some(1));
    assert_eq!(assembled.outline[0].items[0].page_number, Some(3));

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_assembly_refuses_another_window_s_source_and_pages_it_does_not_have() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-refusals");
    let ids = added(
        engine,
        "main",
        vec![write_source(&directory, "source.pdf", banded_pdf(&[20]))],
    );

    assert!(engine
        .assemble_pdf(
            "other",
            plan(vec![page(ids[0], 1, 0)], Vec::new()),
            |_, _| {}
        )
        .is_err());
    assert!(engine
        .assemble_pdf(
            "main",
            plan(vec![page(ids[0], 2, 0)], Vec::new()),
            |_, _| {}
        )
        .is_err());
    assert!(engine
        .assemble_pdf(
            "main",
            plan(vec![page(ids[0], 1, 45)], Vec::new()),
            |_, _| {}
        )
        .is_err());
    assert!(engine
        .assemble_pdf(
            "main",
            plan(
                vec![page(ids[0], 1, 0)],
                vec![AssembleOutlineItem {
                    title: "Past the end".into(),
                    page_number: 2,
                    items: Vec::new(),
                }],
            ),
            |_, _| {},
        )
        .is_err());
    assert!(engine
        .render_organize_thumbnail("other", ids[0], 1, 128)
        .is_err());
    assert!(engine
        .render_organize_thumbnail("main", ids[0], i32::MIN, 128)
        .is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_released_source_can_no_longer_be_drawn_or_assembled() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-release");
    let ids = added(
        engine,
        "main",
        vec![write_source(&directory, "source.pdf", banded_pdf(&[20]))],
    );

    engine
        .render_organize_thumbnail("main", ids[0], 1, 128)
        .expect("a held source should draw");
    engine.release_organize_scope("main", engine.organize_release_cutoff());

    assert!(engine
        .render_organize_thumbnail("main", ids[0], 1, 128)
        .is_err());
    assert!(engine
        .assemble_pdf(
            "main",
            plan(vec![page(ids[0], 1, 0)], Vec::new()),
            |_, _| {}
        )
        .is_err());

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_source_changed_on_disk_is_refused_once_it_must_be_read_again() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-changed");
    let path = write_source(&directory, "source.pdf", banded_pdf(&[20]));
    let ids = added(engine, "changed", vec![path.clone()]);

    // Let go of, as the budget would, so the next use reads the disk, where
    // the file now holds other pages.
    fs::write(&path, banded_pdf(&[20, 60])).expect("the source should be rewritten");
    engine.evict_organize_sources_for_test("changed");

    let error = engine
        .render_organize_thumbnail("changed", ids[0], 1, 128)
        .expect_err("a changed file must not stand in for the one added");

    assert_eq!(error, ORGANIZE_SOURCE_CHANGED);

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_stopped_assembly_hands_back_nothing() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-stopped");
    let ids = added(
        engine,
        "stopped",
        vec![
            write_source(&directory, "first.pdf", banded_pdf(&[20, 60])),
            write_source(&directory, "second.pdf", banded_pdf(&[110])),
        ],
    );
    // Stopped from the run's own progress, where the reader's Stop lands.
    let assembled = engine
        .assemble_pdf(
            "stopped",
            plan(vec![page(ids[0], 1, 0), page(ids[1], 1, 0)], Vec::new()),
            |completed, _| {
                if completed > 0 {
                    engine.cancel_operation(OperationTarget::Merge("stopped".into()));
                }
            },
        )
        .expect("a stopped assembly is not a failure");

    assert!(
        assembled.is_none(),
        "a stopped assembly produces no document"
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_fitted_assembly_lays_every_page_and_blank_on_a4() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-fitted");
    let ids = added(
        engine,
        "main",
        vec![write_source(
            &directory,
            "source.pdf",
            banded_pdf(&[20, 60]),
        )],
    );

    let assembled = engine
        .assemble_pdf(
            "main",
            AssemblePlan {
                slots: vec![
                    page(ids[0], 1, 0),
                    AssembleSlot::Blank {
                        width: 400.0,
                        height: 250.0,
                    },
                    page(ids[0], 2, 90),
                ],
                normalize_a4: true,
                outline: Vec::new(),
            },
            |_, _| {},
        )
        .expect("PDFium should assemble the pages")
        .expect("an assembly nobody stopped hands back its document");

    let sizes: Vec<_> = assembled
        .pages
        .iter()
        .map(|page| (page.width.round(), page.height.round(), page.rotation))
        .collect();

    // A blank keeps the way it was turned; a turned page is turned on its sheet.
    assert_eq!(
        sizes,
        vec![
            (595.0, 842.0, 0.0),
            (842.0, 595.0, 0.0),
            (842.0, 595.0, 90.0)
        ],
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_fitted_assembly_keeps_the_plan_s_order_across_files() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-fitted-interleave");
    let ids = added(
        engine,
        "main",
        vec![
            write_source(&directory, "first.pdf", banded_pdf(&[20])),
            write_source(&directory, "second.pdf", banded_pdf(&[110, 150])),
        ],
    );

    // Built a file at a time, so the middle slot's sheet is made last: only
    // the permutation brings its turn back between the second file's pages.
    let assembled = engine
        .assemble_pdf(
            "main",
            AssemblePlan {
                slots: vec![page(ids[1], 1, 0), page(ids[0], 1, 90), page(ids[1], 2, 0)],
                normalize_a4: true,
                outline: Vec::new(),
            },
            |_, _| {},
        )
        .expect("PDFium should assemble the pages")
        .expect("an assembly nobody stopped hands back its document");

    assert_eq!(
        assembled
            .pages
            .iter()
            .map(|page| page.rotation)
            .collect::<Vec<_>>(),
        vec![0.0, 90.0, 0.0],
    );

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_image_is_a_source_of_its_own_and_an_unreadable_file_is_reported() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-kinds");
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
        .add_organize_sources("main", vec![image, broken], false)
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

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_source_let_go_is_read_again_while_its_file_stands() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-reread");
    let ids = added(
        engine,
        "reread",
        vec![write_source(&directory, "source.pdf", banded_pdf(&[20]))],
    );

    engine.evict_organize_sources_for_test("reread");
    engine
        .render_organize_thumbnail("reread", ids[0], 1, 128)
        .expect("an unchanged file is read again");

    fs::remove_dir_all(directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_late_release_spares_what_the_reloaded_page_added_since() {
    let _organize = organize_test_guard();
    let engine = test_engine();
    let directory = scratch_directory("organize-late-release");
    let before = added(
        engine,
        "reloaded",
        vec![write_source(&directory, "old.pdf", banded_pdf(&[20]))],
    );
    let cutoff = engine.organize_release_cutoff();
    let after = added(
        engine,
        "reloaded",
        vec![write_source(&directory, "new.pdf", banded_pdf(&[60]))],
    );

    engine.release_organize_scope("reloaded", cutoff);

    assert!(engine
        .render_organize_thumbnail("reloaded", before[0], 1, 128)
        .is_err());
    engine
        .render_organize_thumbnail("reloaded", after[0], 1, 128)
        .expect("a source added after the release was asked for stays");

    fs::remove_dir_all(directory).ok();
}
