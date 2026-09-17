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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Jpg,
    Png,
}

/// What one archive holds. The density and pages are bounded by the engine,
/// not by the dialog that picks them: a command's arguments are anyone's to send.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "format",
    rename_all_fields = "camelCase"
)]
pub enum ArchiveOptions {
    /// Every selected page as one JPG or PNG at the chosen density.
    Images {
        image_format: ImageFormat,
        dpi: u32,
        /// One-based page numbers in the document's own numbering; the engine
        /// bounds them again rather than trusting the sender's list.
        pages: Vec<u32>,
    },
    /// One PDF per top-level bookmark section.
    Bookmarks,
    /// One PDF per page.
    Pages,
}

#[tauri::command]
pub async fn export_pdf_archive(
    document_id: u64,
    options: ArchiveOptions,
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
            .export_archive(document_id, &path, options, channel_progress(on_progress))
            .map(|completed| completed.then(|| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("archive export task failed: {error}"))?
}
