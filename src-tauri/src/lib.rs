mod pdfium;

use pdfium::{
    add_pdf_highlight_annotation, close_pdf, delete_last_pdf_annotation, export_pdf,
    extract_pdf_page_text, open_pdf, render_pdf_page, render_pdf_page_thumbnail, PdfiumState,
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
        .invoke_handler(tauri::generate_handler![
            open_pdf,
            render_pdf_page,
            render_pdf_page_thumbnail,
            extract_pdf_page_text,
            add_pdf_highlight_annotation,
            delete_last_pdf_annotation,
            export_pdf,
            close_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running TFolio");
}
