mod pdfium;
mod preferences;
mod recent;

use pdfium::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, close_pdf,
    create_pdf, delete_last_pdf_annotation, delete_pdf_pages, download_pdf_note_font, export_pdf,
    extract_pdf_page_text, insert_pdf_blank_page, insert_pdf_from_path, inspect_pdf_files,
    merge_pdf_files, open_pdf, open_pdf_from_path, pick_pdf_path, pick_pdf_paths,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    reorder_pdf_pages, restore_pdf_pages, save_pdf, PdfiumState,
};
use preferences::{page_numbers_preferences, set_page_numbers_preferences, Preferences};
use recent::{recent_pdfs, RecentFiles};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            let pdfium = PdfiumState::new(app.handle()).map_err(std::io::Error::other)?;
            // An earlier run's recent list is the one thing outside this
            // process that may name a path the reader gets to reopen, and it
            // holds only paths a dialog or a drop produced while this app
            // watched — so approving it is approving the reader's own past
            // gestures, not the WebView's word.
            let recent = RecentFiles::load(app.handle());
            pdfium.approve_paths(recent.stored().iter());
            app.manage(pdfium);
            app.manage(recent);
            app.manage(Preferences::load(app.handle()));
            Ok(())
        })
        // Recorded on the Rust side of the boundary, because this is the only
        // place a drop's paths exist before the WebView has touched them:
        // `open_pdf_from_path` only acts on paths approved here or by the
        // dialog in `pick_pdf_path`.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(state) = window.try_state::<PdfiumState>() {
                    state.approve_paths(paths.iter());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_pdf,
            open_pdf,
            open_pdf_from_path,
            pick_pdf_path,
            pick_pdf_paths,
            inspect_pdf_files,
            merge_pdf_files,
            recent_pdfs,
            render_pdf_page,
            render_pdf_page_thumbnail,
            extract_pdf_page_text,
            add_pdf_highlight_annotation,
            add_pdf_rect_annotation,
            add_pdf_rect_effect_annotation,
            add_pdf_text_note_annotation,
            download_pdf_note_font,
            apply_pdf_watermark,
            delete_last_pdf_annotation,
            remove_pdf_watermark,
            apply_pdf_page_numbers,
            remove_pdf_page_numbers,
            page_numbers_preferences,
            set_page_numbers_preferences,
            reorder_pdf_pages,
            delete_pdf_pages,
            restore_pdf_pages,
            insert_pdf_blank_page,
            insert_pdf_from_path,
            save_pdf,
            export_pdf,
            close_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running TFolio");
}
