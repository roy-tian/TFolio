mod pdfium;

use pdfium::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_watermark, close_pdf, delete_last_pdf_annotation,
    delete_pdf_pages, export_pdf, extract_pdf_page_text, insert_pdf_blank_page, open_pdf,
    open_pdf_from_path, pick_pdf_path, remove_pdf_watermark, render_pdf_page,
    render_pdf_page_thumbnail, reorder_pdf_pages, restore_pdf_pages, save_pdf, PdfiumState,
};
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
            app.manage(pdfium);
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
            open_pdf,
            open_pdf_from_path,
            pick_pdf_path,
            render_pdf_page,
            render_pdf_page_thumbnail,
            extract_pdf_page_text,
            add_pdf_highlight_annotation,
            add_pdf_rect_annotation,
            add_pdf_rect_effect_annotation,
            add_pdf_text_note_annotation,
            apply_pdf_watermark,
            delete_last_pdf_annotation,
            remove_pdf_watermark,
            reorder_pdf_pages,
            delete_pdf_pages,
            restore_pdf_pages,
            insert_pdf_blank_page,
            save_pdf,
            export_pdf,
            close_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running TFolio");
}
