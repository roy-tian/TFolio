use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};

use super::{
    commands::{channel_progress, export_dialog},
    engine::OperationTarget,
    PdfProgress, PdfiumState,
};

#[tauri::command]
pub async fn cancel_pdf_compression(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<bool, String> {
    Ok(state
        .0
        .cancel_operation(OperationTarget::Compress(document_id)))
}

/// Stops the dialog's estimates alone, never the export: a dialog dropping
/// superseded estimates must not stop a copy already being written.
#[tauri::command]
pub async fn cancel_pdf_compression_estimate(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<bool, String> {
    Ok(state
        .0
        .cancel_operation(OperationTarget::CompressEstimate(document_id)))
}

/// The dialog's cache holds a copy or two of the document; once it closes,
/// nothing will ask for them again.
#[tauri::command]
pub async fn release_pdf_compression(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);
    // The store's lock may be held by a long edit; waiting belongs off the
    // IPC thread.
    tauri::async_runtime::spawn_blocking(move || engine.release_compression(document_id))
        .await
        .map_err(|error| format!("compression release task failed: {error}"))?
}

/// The level is bounded by the engine, not by the choices that usually pick
/// it: a command's arguments are anyone's to send.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionOptions {
    /// The resolution images are resampled toward, in pixels per inch of
    /// their drawn size. `None` leaves the images' bytes untouched and
    /// compresses structure alone.
    pub image_dpi: Option<u32>,
}

/// The dialog's bottom line. `estimated_bytes` is the pipeline's own output,
/// exactly what the export will write; `original_bytes` is the opened file's
/// length until an edit or a write, then PDFium's rewrite of the document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionEstimate {
    pub(in crate::pdfium) original_bytes: u64,
    pub(in crate::pdfium) estimated_bytes: u64,
}

impl CompressionEstimate {
    pub(in crate::pdfium) fn new(original_bytes: u64, estimated_bytes: u64) -> Self {
        Self {
            original_bytes,
            estimated_bytes,
        }
    }
}

#[tauri::command]
pub async fn estimate_pdf_compression(
    document_id: u64,
    options: CompressionOptions,
    state: State<'_, PdfiumState>,
) -> Result<Option<CompressionEstimate>, String> {
    let engine = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || engine.estimate_compression(document_id, options))
        .await
        .map_err(|error| format!("compression estimate task failed: {error}"))?
}

#[tauri::command]
pub async fn export_compressed_pdf(
    document_id: u64,
    options: CompressionOptions,
    suggested_name: String,
    filter_label: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    state: State<'_, PdfiumState>,
) -> Result<Option<String>, String> {
    let engine = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = export_dialog(
            &app,
            &engine,
            document_id,
            filter_label,
            &["pdf"],
            &suggested_name,
        )
        .blocking_save_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|error| format!("the chosen destination is unusable: {error}"))?;
        engine
            .export_compressed(document_id, &path, options, channel_progress(on_progress))
            .map(|completed| completed.then(|| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("compressed export task failed: {error}"))?
}
