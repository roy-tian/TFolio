mod pdfium;

use pdfium::{close_pdf, open_pdf, render_pdf_page, PdfiumState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

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
            close_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running TFolio");
}
