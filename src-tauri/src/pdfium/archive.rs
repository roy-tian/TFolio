use std::sync::Arc;

use tauri::{ipc::Channel, State, WebviewWindow};
use tfolio_engine::{ArchiveOptions, OperationTarget};

use super::{
    commands::{channel_progress, pick_export_path},
    DialogOutcome, PdfProgress, PdfiumState, FILE_DIALOG_BUSY,
};

#[tauri::command]
pub async fn cancel_pdf_archive(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<bool, String> {
    Ok(state
        .engine
        .cancel_operation(OperationTarget::Archive(document_id)))
}

#[tauri::command]
pub async fn export_pdf_archive(
    document_id: u64,
    options: ArchiveOptions,
    suggested_name: String,
    filter_label: String,
    on_progress: Channel<PdfProgress>,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let path = match pick_export_path(
        &state,
        &window,
        Some(document_id),
        filter_label,
        &["zip"],
        suggested_name,
    )
    .await?
    {
        DialogOutcome::Picked(path) => path,
        DialogOutcome::Cancelled => return Ok(None),
        DialogOutcome::Busy => return Err(FILE_DIALOG_BUSY.into()),
    };
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .export_archive(document_id, &path, options, channel_progress(on_progress))
            .map(|completed| completed.then(|| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("archive export task failed: {error}"))?
}
