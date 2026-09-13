use super::super::inspection::is_a4_size;
use super::support::*;
use super::*;

#[test]
fn a4_sizes_accept_rounding_and_both_orientations() {
    assert!(is_a4_size(595.0, 842.0));
    assert!(is_a4_size(841.89, 595.276));
    assert!(!is_a4_size(612.0, 792.0));
    assert!(!is_a4_size(595.0, 850.0));
    assert!(!is_a4_size(f32::NAN, 842.0));
    assert!(!is_a4_size(595.0, f32::INFINITY));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn inspection_checks_every_page_and_reports_unreadable_sizes_as_unknown() {
    let engine = test_engine();
    let directory = scratch_directory("inspect-a4");
    let all_a4 = directory.join("a4.pdf");
    let mixed = directory.join("mixed.pdf");
    let broken = directory.join("broken.pdf");
    {
        let _documents = engine.lock_documents().unwrap();
        let mut document = engine.pdfium.create_new_pdf().unwrap();
        for (width, height) in [(595.0, 842.0), (842.0, 595.0)] {
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::Custom(
                    PdfPoints::new(width),
                    PdfPoints::new(height),
                ))
                .unwrap();
        }
        fs::write(&all_a4, document.save_to_bytes().unwrap()).unwrap();
        document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::Custom(
                PdfPoints::new(612.0),
                PdfPoints::new(792.0),
            ))
            .unwrap();
        fs::write(&mixed, document.save_to_bytes().unwrap()).unwrap();
    }
    fs::write(&broken, b"unreadable PDF").unwrap();
    let summaries = engine
        .inspect_files(vec![all_a4, mixed, broken], false)
        .unwrap();
    assert_eq!(summaries[0].all_pages_a4, Some(true));
    assert_eq!(summaries[0].page_count, Some(2));
    assert_eq!(summaries[1].all_pages_a4, Some(false));
    assert_eq!(summaries[1].page_count, Some(3));
    assert_eq!(summaries[2].all_pages_a4, None);
    assert_eq!(summaries[2].page_count, None);
    fs::remove_dir_all(directory).unwrap();
}
