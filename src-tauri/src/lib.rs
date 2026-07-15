mod pdfium;

use pdfium::{close_pdf, open_pdf, render_pdf_page, PdfiumState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
