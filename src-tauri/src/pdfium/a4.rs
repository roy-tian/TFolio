//! Fit to A4: every page fitted onto an A4 sheet in a new unsaved document,
//! opened in a tab beside the original so the reader can review it and save
//! manually.

use std::sync::Arc;

use serde::Serialize;
use tauri::{ipc::Channel, State, WebviewWindow};
use tfolio_engine::PdfDocumentInfo;

use super::{commands::channel_progress, PdfProgress, PdfiumState};
use crate::windows::{page_generation, record_document, DocumentFile, DocumentOwners};

/// An in-memory A4 copy, not bound to any file until the reader saves it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A4Fitted {
    document: PdfDocumentInfo,
    /// The session's watermark or page numbers went along at the page's scale.
    layers_scaled: bool,
}

/// Builds an in-memory A4 copy of this window's document without writing to
/// disk; `None` for a stopped build or one whose page reloaded or closed.
#[tauri::command]
pub async fn fit_a4_pdf(
    document_id: u64,
    on_progress: Channel<PdfProgress>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<Option<A4Fitted>, String> {
    if !owners.owns(document_id, window.label()) {
        return Err("this window does not hold that document".into());
    }

    let page = page_generation(&window);
    let engine = Arc::clone(&state.engine);
    let fitted = tauri::async_runtime::spawn_blocking(move || {
        engine.fit_to_a4(document_id, channel_progress(on_progress))
    })
    .await
    .map_err(|error| format!("PDFium A4 task failed: {error}"))??;
    let Some(copy) = fitted else {
        return Ok(None);
    };

    record_document(
        &owners,
        &window,
        page,
        copy.document.id(),
        DocumentFile::None,
    );

    if !owners.owns(copy.document.id(), window.label()) {
        return Ok(None);
    }

    Ok(Some(A4Fitted {
        document: copy.document,
        layers_scaled: copy.layers_scaled,
    }))
}
