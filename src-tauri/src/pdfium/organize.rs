//! The organize workspace's commands: its sources are the asking window's, and
//! the engine refuses another window's ids.

use std::{path::PathBuf, sync::Arc};

use tauri::{
    ipc::{Channel, Response},
    AppHandle, Manager, State, WebviewWindow,
};
use tfolio_engine::{AssemblePlan, OrganizeSourceInfo, PdfDocumentInfo};

#[cfg(not(feature = "e2e"))]
use super::commands::ensure_approved;
use super::{
    commands::{channel_progress, export_and_bind, export_dialog},
    encode::encode_webp,
    PdfProgress, PdfiumState,
};
use crate::windows::{page_generation, record_document, DocumentOwners, PageGeneration};

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

/// Preview: the plan's pages as a new document that exists only in memory,
/// so it has nowhere to save to until its first export adopts a destination.
#[tauri::command]
pub async fn assemble_pdf(
    plan: AssemblePlan,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let page = page_generation(&window);

    assemble_recorded(plan, on_progress, &app, &window, page).await
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
    state: State<'_, PdfiumState>,
    window: WebviewWindow,
) -> Result<Option<PdfDocumentInfo>, String> {
    let page = page_generation(&window);
    let engine = Arc::clone(&state.engine);
    let dialog_app = app.clone();
    // `blocking_save_file` would deadlock the main thread outside `spawn_blocking`.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        export_dialog(
            &dialog_app,
            &engine,
            None,
            filter_label,
            &["pdf"],
            &suggested_name,
        )
        .blocking_save_file()
    })
    .await
    .map_err(|error| format!("dialog task failed: {error}"))?;
    // A page that reloaded or closed while the dialog was up has nothing left
    // to show the PDF in, and a destroy's cancellation came before the build.
    let Some(picked) = picked.filter(|_| page_generation(&window) == page) else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("the chosen destination is unusable: {error}"))?;

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

/// Builds the plan's document and records it as the window's. `None` for a
/// stopped assembly, and for one whose page reloaded or closed meanwhile:
/// that has already closed the document, and nothing is left to show it.
async fn assemble_recorded(
    plan: AssemblePlan,
    on_progress: Channel<PdfProgress>,
    app: &AppHandle,
    window: &WebviewWindow,
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
    let owners = app.state::<DocumentOwners>();

    record_document(&owners, window, page, document.id(), None);

    Ok(owners
        .owns(document.id(), window.label())
        .then_some(document))
}

/// Builds the plan's document and writes it to `path`, which it is then bound
/// to: it opens as that file's tab, as an open of it would.
async fn assemble_into(
    plan: AssemblePlan,
    path: PathBuf,
    on_progress: Channel<PdfProgress>,
    app: AppHandle,
    window: WebviewWindow,
    page: PageGeneration,
) -> Result<Option<PdfDocumentInfo>, String> {
    let Some(document) = assemble_recorded(plan, on_progress, &app, &window, page).await? else {
        return Ok(None);
    };
    let id = document.id();
    let engine = Arc::clone(&app.state::<PdfiumState>().engine);
    let shown = path.to_string_lossy().into_owned();
    let task_app = app.clone();
    let written =
        tauri::async_runtime::spawn_blocking(move || export_and_bind(&task_app, &engine, id, path))
            .await
            .map_err(|error| format!("PDFium export task failed: {error}"));

    match written {
        Ok(Ok(_)) => Ok(Some(document.bound_to(shown))),
        // An unwritten document has no file to open as; the arrangement is
        // still there to try another destination, or a preview.
        Ok(Err(error)) | Err(error) => {
            app.state::<DocumentOwners>().release(id);
            app.state::<PdfiumState>().close_document_detached(id);

            Err(error)
        }
    }
}
