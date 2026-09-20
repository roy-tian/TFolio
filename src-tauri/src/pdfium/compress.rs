use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::{
    commands::{channel_progress, suggested_file_name},
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

/// The levels are bounded by the engine, not by the sliders that usually pick
/// them: a command's arguments are anyone's to send.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "mode",
    rename_all_fields = "camelCase"
)]
pub enum CompressionOptions {
    /// PDFium's own rewrite, then object and cross-reference streams: every
    /// page keeps its text and vectors.
    Lossless,
    /// Every page redrawn as one JPEG at the given density and quality —
    /// what the text layer loses.
    Rasterized { dpi: u32, quality: u32 },
}

/// The dialog's bottom line. `exact` tells the reader whether the figure is
/// the pipeline's own output or an extrapolation across sampled pages.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionEstimate {
    pub(in crate::pdfium) original_bytes: u64,
    pub(in crate::pdfium) estimated_bytes: u64,
    pub(in crate::pdfium) exact: bool,
}

impl CompressionEstimate {
    pub(in crate::pdfium) fn new(original_bytes: u64, estimated_bytes: u64, exact: bool) -> Self {
        Self {
            original_bytes,
            estimated_bytes,
            exact,
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
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter(filter_label, &["pdf"])
            .set_file_name(suggested_file_name(&suggested_name))
            .blocking_save_file()
        else {
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
