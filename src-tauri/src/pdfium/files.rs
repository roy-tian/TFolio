//! The commands that add files to a document: the files read are the asking
//! window's, and the engine refuses another window's ids.

use std::{path::PathBuf, sync::Arc};

use tauri::{State, WebviewWindow};
use tfolio_engine::{FileOptions, FileSourceInfo, PdfStructureUpdate, SignatureDecision};

#[cfg(not(feature = "e2e"))]
use super::commands::ensure_approved;
use super::PdfiumState;
use crate::windows::DocumentOwners;

/// Files read for their pages and kept by the asking window until a document
/// takes them. Approved like an open: a source's pages are its contents.
#[tauri::command]
pub async fn read_pdf_sources(
    paths: Vec<String>,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<Vec<FileSourceInfo>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    #[cfg(not(feature = "e2e"))]
    for path in &paths {
        ensure_approved(&state, path)?;
    }

    let engine = Arc::clone(&state.engine);
    let word = state.word_available();
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || engine.read_sources(&label, paths, word))
        .await
        .map_err(|error| format!("PDFium source task failed: {error}"))?
}

/// Files `read_pdf_sources` read, added to a document of this window as
/// files of its own: the sources are this window's, and so must the document be.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn insert_pdf_files(
    document_id: u64,
    source_ids: Vec<u64>,
    index: i32,
    own_title: String,
    options: FileOptions,
    signatures: Option<SignatureDecision>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    if !owners.owns(document_id, window.label()) {
        return Err("this window does not hold that document".into());
    }

    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        engine.insert_sources(
            &label,
            document_id,
            &source_ids,
            index,
            &own_title,
            options,
            signatures,
        )
    })
    .await
    .map_err(|error| format!("PDFium file insertion task failed: {error}"))?
}

/// Sources read for files that were never added after all; only this
/// window's are let go.
#[tauri::command]
pub async fn release_pdf_sources(
    source_ids: Vec<u64>,
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<(), String> {
    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || engine.release_sources(&label, &source_ids))
        .await
        .map_err(|error| format!("PDFium release task failed: {error}"))
}

/// How a document's files are laid out and saved, as the reader set it.
#[tauri::command]
pub async fn set_pdf_file_options(
    document_id: u64,
    options: FileOptions,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || engine.set_file_options(document_id, options))
        .await
        .map_err(|error| format!("PDFium options task failed: {error}"))?
}

/// The name a file of the document goes by, and its bookmark in a Save As.
#[tauri::command]
pub async fn rename_pdf_section(
    document_id: u64,
    section_id: u64,
    title: String,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || {
        engine.rename_section(document_id, section_id, &title)
    })
    .await
    .map_err(|error| format!("PDFium rename task failed: {error}"))?
}
