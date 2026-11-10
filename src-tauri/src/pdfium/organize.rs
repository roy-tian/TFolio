//! The organize workspace's commands: its sources are the asking window's, and
//! the engine refuses another window's ids.

use std::{path::PathBuf, sync::Arc};

use tauri::{
    ipc::{Channel, Response},
    AppHandle, Manager, State, WebviewWindow,
};
use tfolio_engine::{
    AssemblePlan, FileOptions, OrganizeSourceInfo, PdfDocumentInfo, PdfStructureUpdate,
    SignatureDecision, WatermarkConfig,
};

#[cfg(not(feature = "e2e"))]
use super::commands::ensure_approved;
use super::{
    commands::{bind_new_document, channel_progress, pick_new_pdf},
    encode::encode_webp,
    PdfProgress, PdfiumState,
};
use crate::windows::{page_generation, DocumentOwners, PageGeneration};

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

/// Files `add_organize_sources` read, added to a document of this window as
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
        engine.insert_organize_sources(
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

/// Whether a watermark the workspace is given can be drawn, checked when it
/// is set rather than when a save has already asked where the PDF goes.
#[tauri::command]
pub async fn check_organize_watermark(
    config: WatermarkConfig,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.engine);

    tauri::async_runtime::spawn_blocking(move || engine.check_watermark(config))
        .await
        .map_err(|error| format!("PDFium watermark check failed: {error}"))?
}

/// Asks where the new PDF goes before building it: a cancelled dialog costs
/// no assembly. The dialog is this command's own, as `export_pdf`'s is, since
/// a path argument would be an arbitrary-file write for any page code.
#[tauri::command]
pub async fn save_assembled_pdf(
    plan: AssemblePlan,
    suggested_name: String,
    filter_label: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let page = page_generation(&window);
    let Some(path) = pick_new_pdf(&app, None, filter_label, suggested_name, &window, page).await?
    else {
        return Ok(None);
    };

    assemble_into(plan, path, on_progress, app, window, page).await
}

/// `save_assembled_pdf` past its dialog, which no driver can answer. Taking
/// the path is the arbitrary-file write that command exists to prevent, so
/// this is compiled into the e2e build alone.
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn save_assembled_pdf_to(
    plan: AssemblePlan,
    path: String,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let page = page_generation(&window);

    assemble_into(plan, PathBuf::from(path), on_progress, app, window, page).await
}

/// Builds the plan's document and binds it to `path`, as an open of that file
/// would; `None` for a stopped assembly and for one whose page reloaded or
/// closed meanwhile.
async fn assemble_into(
    plan: AssemblePlan,
    path: PathBuf,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
    page: PageGeneration,
) -> Result<Option<PdfDocumentInfo>, String> {
    let engine = Arc::clone(&app.state::<PdfiumState>().engine);
    let label = window.label().to_string();
    let assembled = tauri::async_runtime::spawn_blocking(move || {
        engine.assemble_pdf(&label, plan, channel_progress(on_progress))
    })
    .await
    .map_err(|error| format!("PDFium assembly task failed: {error}"))??;
    let Some(document) = assembled else {
        return Ok(None);
    };

    bind_new_document(document, path, app, &window, page).await
}
