//! The organize workspace's commands: its sources are the asking window's, and
//! the engine refuses another window's ids.

use std::{path::PathBuf, sync::Arc};

use tauri::{
    ipc::{Channel, Response},
    State, WebviewWindow,
};
use tfolio_engine::{AssemblePlan, OrganizeSourceInfo, PdfDocumentInfo};

#[cfg(not(feature = "e2e"))]
use super::commands::ensure_approved;
use super::{commands::channel_progress, encode::encode_webp, PdfProgress, PdfiumState};
use crate::windows::{page_generation, record_document, DocumentOwners};

/// The organize workspace's files, read for their pages and kept by the
/// asking window. Approved like an open: a source's pages are its contents.
#[tauri::command]
pub async fn add_organize_sources(
    paths: Vec<String>,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<Vec<OrganizeSourceInfo>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    #[cfg(not(feature = "e2e"))]
    for path in &paths {
        ensure_approved(&state, path)?;
    }

    let engine = Arc::clone(&state.engine);
    let word = state.word_available();
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || engine.add_organize_sources(&label, paths, word))
        .await
        .map_err(|error| format!("PDFium source task failed: {error}"))?
}

/// Only the asking window's sources: the engine refuses another's id.
#[tauri::command]
pub async fn render_organize_thumbnail(
    source_id: u64,
    page_number: i32,
    width: i32,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<Response, String> {
    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let thumbnail = engine.render_organize_thumbnail(&label, source_id, page_number, width)?;

        encode_webp(&thumbnail)
            .map_err(|error| format!("could not encode the page thumbnail: {error}"))
    })
    .await
    .map_err(|error| format!("PDFium thumbnail task failed: {error}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn release_organize_sources(
    source_ids: Vec<u64>,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<(), String> {
    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        engine.release_organize_sources(&label, &source_ids)
    })
    .await
    .map_err(|error| format!("PDFium release task failed: {error}"))?
}

/// Like a merge's, the result has no source path, and `None` is the reader
/// stopping it — through `cancel_pdf_merge`, the window's one build to stop.
#[tauri::command]
pub async fn assemble_pdf(
    plan: AssemblePlan,
    on_progress: Channel<PdfProgress>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let engine = Arc::clone(&state.engine);
    let page = page_generation(&window);
    let label = window.label().to_string();

    let assembled = tauri::async_runtime::spawn_blocking(move || {
        engine.assemble_pdf(&label, plan, channel_progress(on_progress))
    })
    .await
    .map_err(|error| format!("PDFium assembly task failed: {error}"))??;

    if let Some(document) = &assembled {
        record_document(&owners, &window, page, document.id(), None);
    }

    Ok(assembled)
}
