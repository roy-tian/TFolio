//! Save as A4: the document's pages fitted onto A4 as a new file, which the
//! asking tab then shows in place of the document it was made from.

use std::{path::PathBuf, sync::Arc};

use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tfolio_engine::PdfDocumentInfo;

use super::{
    commands::{bind_new_document, channel_progress, pick_new_pdf},
    PdfProgress, PdfiumState,
};
use crate::windows::{page_generation, DocumentOwners, PageGeneration};

/// Asks where the A4 copy goes before building it, as a Save As does. Only
/// this window's document.
#[tauri::command]
pub async fn save_a4_pdf(
    document_id: u64,
    suggested_name: String,
    filter_label: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    if !owners.owns(document_id, window.label()) {
        return Err("this window does not hold that document".into());
    }

    let page = page_generation(&window);
    let Some(path) = pick_new_pdf(
        &app,
        Some(document_id),
        filter_label,
        suggested_name,
        &window,
        page,
    )
    .await?
    else {
        return Ok(None);
    };

    // The dialog took the reader's time, in which the tab may have left.
    if !owners.owns(document_id, window.label()) {
        return Err("this window does not hold that document".into());
    }

    fit_into(document_id, path, on_progress, app, window, page).await
}

/// `save_a4_pdf` past its dialog, which no driver can answer. Taking the path
/// is the arbitrary-file write that command exists to prevent, so this is
/// compiled into the e2e build alone.
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn save_a4_pdf_to(
    document_id: u64,
    path: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let page = page_generation(&window);

    fit_into(
        document_id,
        PathBuf::from(path),
        on_progress,
        app,
        window,
        page,
    )
    .await
}

/// Builds the A4 copy and binds it to `path`, as a Save As binds; `None` for
/// a stopped build and for one whose page reloaded or closed meanwhile.
async fn fit_into(
    document_id: u64,
    path: PathBuf,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
    page: PageGeneration,
) -> Result<Option<PdfDocumentInfo>, String> {
    let engine = Arc::clone(&app.state::<PdfiumState>().engine);
    let fitted = tauri::async_runtime::spawn_blocking({
        let path = path.clone();

        // Refused before the build rather than after it: a file open in
        // another tab, or a signed one, could only end the work at the write.
        move || {
            engine.check_new_file_destination(&path)?;
            engine.fit_to_a4(document_id, channel_progress(on_progress))
        }
    })
    .await
    .map_err(|error| format!("PDFium A4 task failed: {error}"))??;
    let Some(document) = fitted else {
        return Ok(None);
    };

    bind_new_document(document, path, app, &window, page).await
}
