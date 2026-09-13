use std::sync::Arc;

use serde::Deserialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::{
    commands::{channel_progress, suggested_file_name},
    engine::OperationTarget,
    PdfProgress, PdfiumState,
};

#[tauri::command]
pub async fn cancel_pdf_archive(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<bool, String> {
    Ok(state
        .0
        .cancel_operation(OperationTarget::Archive(document_id)))
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    Jpg,
    Png,
    Bookmarks,
}

#[tauri::command]
pub async fn export_pdf_archive(
    document_id: u64,
    format: ArchiveFormat,
    suggested_name: String,
    filter_label: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    state: State<'_, PdfiumState>,
) -> Result<Option<String>, String> {
    let engine = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter(filter_label, &["zip"])
            .set_file_name(suggested_file_name(&suggested_name))
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|error| format!("the chosen destination is unusable: {error}"))?;
        engine
            .export_archive(document_id, &path, format, channel_progress(on_progress))
            .map(|completed| completed.then(|| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("archive export task failed: {error}"))?
}
