//! The commands that add files to a document: the files read are the asking
//! window's, and the engine refuses another window's ids.

use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use serde::Serialize;
use tauri::{ipc::Channel, State, WebviewWindow};
use tfolio_engine::{
    FileOptions, FileSourceInfo, PdfDocumentInfo, PdfStructureUpdate, SignatureDecision,
};

#[cfg(not(feature = "e2e"))]
use super::commands::ensure_approved;
use super::PdfiumState;
use crate::windows::{page_generation, record_document, DocumentFile, DocumentOwners};

/// Which file of a long add or merge is under way: how many went before it,
/// of how many, and its name.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProgress {
    completed: usize,
    total: usize,
    name: String,
}

fn send_progress(
    on_progress: Channel<SourceProgress>,
) -> impl FnMut(usize, usize, &std::path::Path) {
    move |completed, total, path| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = on_progress.send(SourceProgress {
            completed,
            total,
            name,
        });
    }
}

/// Each file's size on disk, 0 for one that cannot be read, so the reader can
/// be asked before an add or a merge goes past its limits. Approved like a
/// read: a size is the file's to tell.
#[tauri::command]
pub async fn source_sizes(
    paths: Vec<String>,
    state: State<'_, PdfiumState>,
) -> Result<Vec<u64>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    #[cfg(not(feature = "e2e"))]
    for path in &paths {
        ensure_approved(&state, path)?;
    }
    #[cfg(feature = "e2e")]
    let _ = state;

    // Off the async runtime: hundreds of stats, perhaps on a network share.
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| {
                fs::metadata(path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
            })
            .collect()
    })
    .await
    .map_err(|error| format!("source size task failed: {error}"))
}

/// Files read for their pages and kept by the asking window until a document
/// takes them. Approved like an open: a source's pages are its contents.
#[tauri::command]
pub async fn read_pdf_sources(
    paths: Vec<String>,
    on_progress: Channel<SourceProgress>,
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

    tauri::async_runtime::spawn_blocking(move || {
        engine.read_sources_reporting(&label, paths, word, &mut send_progress(on_progress))
    })
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
    signatures: HashMap<u64, SignatureDecision>,
    on_progress: Channel<SourceProgress>,
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
        engine.insert_sources_reporting(
            &label,
            document_id,
            &source_ids,
            index,
            &own_title,
            options,
            &signatures,
            &mut send_progress(on_progress),
        )
    })
    .await
    .map_err(|error| format!("PDFium file insertion task failed: {error}"))?
}

/// Files `read_pdf_sources` read, made into a new document of this window's
/// with no file, as the files a Save As would write.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn merge_pdf_sources(
    source_ids: Vec<u64>,
    own_title: String,
    options: FileOptions,
    signatures: HashMap<u64, SignatureDecision>,
    on_progress: Channel<SourceProgress>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfDocumentInfo, String> {
    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();
    let page = page_generation(&window);

    let merged = tauri::async_runtime::spawn_blocking(move || {
        engine.merge_sources_reporting(
            &label,
            &source_ids,
            &own_title,
            options,
            &signatures,
            &mut send_progress(on_progress),
        )
    })
    .await
    .map_err(|error| format!("PDFium merge task failed: {error}"))??;

    record_document(&owners, &window, page, merged.id(), DocumentFile::None);

    Ok(merged)
}

/// This window's sources read back from disk at their next insert, as those
/// past the parsed budget are: no spec reads 512 MB of files to get there.
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn unload_pdf_sources(
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<(), String> {
    let engine = Arc::clone(&state.engine);
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || engine.unload_sources(&label))
        .await
        .map_err(|error| format!("PDFium unload task failed: {error}"))
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

fn ensure_document_owner(
    owners: &DocumentOwners,
    document_id: u64,
    window: &WebviewWindow,
) -> Result<(), String> {
    if !owners.owns(document_id, window.label()) {
        return Err("this window does not hold that document".into());
    }

    Ok(())
}

/// The name a file of the document goes by, and its bookmark in a Save As.
#[tauri::command]
pub async fn rename_pdf_section(
    document_id: u64,
    section_id: u64,
    title: String,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    ensure_document_owner(&owners, document_id, &window)?;
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || {
        engine.rename_section(document_id, section_id, &title)
    })
    .await
    .map_err(|error| format!("PDFium rename task failed: {error}"))?
}

/// Gives a bookmark in the document (or in one of its sections) a new title.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rename_pdf_bookmark(
    document_id: u64,
    section_id: Option<u64>,
    path: Vec<usize>,
    title: String,
    exact: Option<bool>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    ensure_document_owner(&owners, document_id, &window)?;
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || {
        engine.rename_bookmark(
            document_id,
            section_id,
            &path,
            &title,
            exact.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| format!("PDFium bookmark rename task failed: {error}"))?
}

/// Adds a new bookmark pointing to `page_number` in the document (or in one of its sections).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_pdf_bookmark(
    document_id: u64,
    section_id: Option<u64>,
    path: Vec<usize>,
    page_number: i32,
    title: String,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    ensure_document_owner(&owners, document_id, &window)?;
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_bookmark(document_id, section_id, &path, page_number, &title)
    })
    .await
    .map_err(|error| format!("PDFium bookmark add task failed: {error}"))?
}

/// Deletes a bookmark (and its descendants), optionally stashing them under `stash_id` for undo.
#[tauri::command]
pub async fn delete_pdf_bookmark(
    document_id: u64,
    section_id: Option<u64>,
    path: Vec<usize>,
    stash_id: Option<u64>,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    ensure_document_owner(&owners, document_id, &window)?;
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || match stash_id {
        Some(stash_id) => engine.delete_bookmark(document_id, section_id, &path, stash_id),
        None => engine.remove_bookmark(document_id, section_id, &path),
    })
    .await
    .map_err(|error| format!("PDFium bookmark deletion task failed: {error}"))?
}

/// Restores a previously deleted bookmark subtree from `stash_id`.
#[tauri::command]
pub async fn restore_pdf_bookmark(
    document_id: u64,
    stash_id: u64,
    state: State<'_, PdfiumState>,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<PdfStructureUpdate, String> {
    ensure_document_owner(&owners, document_id, &window)?;
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || engine.restore_bookmark(document_id, stash_id))
        .await
        .map_err(|error| format!("PDFium bookmark restore task failed: {error}"))?
}
