use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, State,
};
use tauri_plugin_dialog::DialogExt;

use super::{
    size_limit_error, ExportOutcome, MergeOutcome, PageNumbersConfig, PagePoint, PagePointsRect,
    PdfDocumentInfo, PdfStructureUpdate, PdfTextSpan, PdfiumState, RectEffect, RectStyle,
    TextNoteStyle, WatermarkConfig, MAX_PDF_BYTES,
};

#[tauri::command]
pub async fn open_pdf(
    request: Request<'_>,
    state: State<'_, PdfiumState>,
) -> Result<PdfDocumentInfo, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("open_pdf requires a raw PDF byte payload".into());
    };

    if bytes.len() > MAX_PDF_BYTES {
        return Err(size_limit_error());
    }

    let bytes = bytes.clone();
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.open(bytes))
        .await
        .map_err(|error| format!("PDFium open task failed: {error}"))?
}

#[tauri::command]
pub async fn render_pdf_page(
    document_id: u64,
    page_number: i32,
    width: i32,
    state: State<'_, PdfiumState>,
) -> Result<Response, String> {
    let engine = Arc::clone(&state.0);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        engine.render_page(document_id, page_number, width)
    })
    .await
    .map_err(|error| format!("PDFium render task failed: {error}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn render_pdf_page_thumbnail(
    document_id: u64,
    page_number: i32,
    width: i32,
    state: State<'_, PdfiumState>,
) -> Result<Response, String> {
    let engine = Arc::clone(&state.0);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        engine.render_thumbnail(document_id, page_number, width)
    })
    .await
    .map_err(|error| format!("PDFium thumbnail task failed: {error}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn extract_pdf_page_text(
    document_id: u64,
    page_number: i32,
    state: State<'_, PdfiumState>,
) -> Result<Vec<PdfTextSpan>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.extract_text(document_id, page_number))
        .await
        .map_err(|error| format!("PDFium text extraction task failed: {error}"))?
}

#[tauri::command]
pub async fn add_pdf_highlight_annotation(
    document_id: u64,
    page_number: i32,
    quads: Vec<PagePointsRect>,
    color: String,
    opacity: f32,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_highlight(document_id, page_number, &quads, &color, opacity)
    })
    .await
    .map_err(|error| format!("PDFium highlight task failed: {error}"))?
}

#[tauri::command]
pub async fn add_pdf_rect_annotation(
    document_id: u64,
    page_number: i32,
    bounds: PagePointsRect,
    style: RectStyle,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_rect(document_id, page_number, &bounds, &style)
    })
    .await
    .map_err(|error| format!("PDFium rectangle task failed: {error}"))?
}

#[tauri::command]
pub async fn add_pdf_rect_effect_annotation(
    document_id: u64,
    page_number: i32,
    bounds: PagePointsRect,
    effect: RectEffect,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_rect_effect(document_id, page_number, &bounds, &effect)
    })
    .await
    .map_err(|error| format!("PDFium rectangle effect task failed: {error}"))?
}

#[tauri::command]
pub async fn add_pdf_text_note_annotation(
    document_id: u64,
    page_number: i32,
    origin: PagePoint,
    text: String,
    style: TextNoteStyle,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_text_note(document_id, page_number, &origin, &text, &style)
    })
    .await
    .map_err(|error| format!("PDFium note task failed: {error}"))?
}

#[tauri::command]
pub async fn apply_pdf_watermark(
    document_id: u64,
    config: WatermarkConfig,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.apply_watermark(document_id, config))
        .await
        .map_err(|error| format!("PDFium watermark task failed: {error}"))?
}

#[tauri::command]
pub async fn remove_pdf_watermark(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.remove_watermark(document_id))
        .await
        .map_err(|error| format!("PDFium watermark removal task failed: {error}"))?
}

#[tauri::command]
pub async fn apply_pdf_page_numbers(
    document_id: u64,
    config: PageNumbersConfig,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.apply_page_numbers(document_id, config))
        .await
        .map_err(|error| format!("PDFium page-number task failed: {error}"))?
}

#[tauri::command]
pub async fn remove_pdf_page_numbers(
    document_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.remove_page_numbers(document_id))
        .await
        .map_err(|error| format!("PDFium page-number removal task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_last_pdf_annotation(
    document_id: u64,
    page_number: i32,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.delete_last_annotation(document_id, page_number)
    })
    .await
    .map_err(|error| format!("PDFium annotation removal task failed: {error}"))?
}

#[tauri::command]
pub async fn reorder_pdf_pages(
    document_id: u64,
    order: Vec<i32>,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.reorder_pages(document_id, &order))
        .await
        .map_err(|error| format!("PDFium reorder task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_pdf_pages(
    document_id: u64,
    page_numbers: Vec<i32>,
    stash_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.delete_pages(document_id, &page_numbers, stash_id)
    })
    .await
    .map_err(|error| format!("PDFium page deletion task failed: {error}"))?
}

#[tauri::command]
pub async fn restore_pdf_pages(
    document_id: u64,
    stash_id: u64,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.restore_pages(document_id, stash_id))
        .await
        .map_err(|error| format!("PDFium page restore task failed: {error}"))?
}

#[tauri::command]
pub async fn insert_pdf_blank_page(
    document_id: u64,
    index: i32,
    state: State<'_, PdfiumState>,
) -> Result<PdfStructureUpdate, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.insert_blank_page(document_id, index))
        .await
        .map_err(|error| format!("PDFium page insertion task failed: {error}"))?
}

/// Shows the native open dialog and hands back the chosen path — recorded as
/// approved, which is what entitles `open_pdf_from_path` to act on it later.
#[tauri::command]
pub async fn pick_pdf_path(
    filter_label: String,
    app: AppHandle,
    state: State<'_, PdfiumState>,
) -> Result<Option<String>, String> {
    let engine = Arc::clone(&state.0);

    // `blocking_pick_file` parks this thread until the reader answers; in
    // `spawn_blocking` that is fine, as `export_pdf` already relies on.
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter(filter_label, &["pdf"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|error| format!("the chosen file is unusable: {error}"))?;

        engine.approve_paths([&path]);
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("dialog task failed: {error}"))?
}

#[tauri::command]
pub async fn open_pdf_from_path(
    path: String,
    state: State<'_, PdfiumState>,
) -> Result<PdfDocumentInfo, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);

        // A path is a string any page code can make up, and opening one binds
        // it as the file `save_pdf` will overwrite — so only paths the OS
        // produced in this process's sight (a drop the window handler saw, a
        // pick `pick_pdf_path` returned) are acted on. The e2e harness opens
        // scratch files no dialog ever blessed, so its build waives the check.
        #[cfg(not(feature = "e2e"))]
        if !engine.is_approved(&path) {
            return Err(format!(
                "{} did not come from a file dialog or a drop",
                path.display()
            ));
        }

        engine.open_from_path(path)
    })
    .await
    .map_err(|error| format!("PDFium open task failed: {error}"))?
}

#[tauri::command]
pub async fn merge_pdf_from_path(
    document_id: u64,
    path: String,
    state: State<'_, PdfiumState>,
) -> Result<MergeOutcome, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);

        // The same approval a fresh open needs, and for the same reason: a
        // merge reads a file the WebView named, so only paths the OS produced
        // in this process's sight (a drop the window saw, a pick the dialog
        // returned) are acted on. The e2e harness merges scratch files no
        // dialog blessed, so its build waives the check — as `open_pdf_from_path`
        // does at its one call site.
        #[cfg(not(feature = "e2e"))]
        if !engine.is_approved(&path) {
            return Err(format!(
                "{} did not come from a file dialog or a drop",
                path.display()
            ));
        }

        engine.merge_from_path(document_id, path)
    })
    .await
    .map_err(|error| format!("PDFium merge task failed: {error}"))?
}

#[tauri::command]
pub async fn save_pdf(document_id: u64, state: State<'_, PdfiumState>) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.save(document_id))
        .await
        .map_err(|error| format!("PDFium save task failed: {error}"))?
}

/// Only a file name may reach the dialog: the WebView chooses what the dialog
/// *suggests*, and a suggestion carrying directories would start the reader in
/// a place of the page's choosing.
fn suggested_file_name(suggested: &str) -> String {
    Path::new(suggested)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf")
        .to_string()
}

/// Asks the reader where to export, then writes there. `None` means they
/// cancelled.
///
/// The dialog is this command's own rather than the WebView's: a path argument
/// here would be an arbitrary-file write for any code that got into the page,
/// since Tauri's ACL does not cover this app's own commands. The WebView only
/// gets to say *that* an export happens — and to suggest, via `suggested_name`
/// and the localized `filter_label`, how the dialog reads — never where the
/// bytes land.
#[tauri::command]
pub async fn export_pdf(
    document_id: u64,
    suggested_name: String,
    filter_label: String,
    app: AppHandle,
    state: State<'_, PdfiumState>,
) -> Result<Option<ExportOutcome>, String> {
    let engine = Arc::clone(&state.0);

    // `blocking_save_file` parks this thread on the dialog until the reader
    // answers, which would deadlock the main thread; in `spawn_blocking` it is
    // fine, and the document lock is not taken until they have chosen.
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

        engine.export_to(document_id, &path).map(Some)
    })
    .await
    .map_err(|error| format!("PDFium export task failed: {error}"))?
}

// Async like every other command, although the close itself is a map removal:
// it takes the documents lock, and a sync command runs on the main thread —
// which would freeze the UI for as long as a save in flight holds that lock.
#[tauri::command]
pub async fn close_pdf(document_id: u64, state: State<'_, PdfiumState>) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.close(document_id))
        .await
        .map_err(|error| format!("PDFium close task failed: {error}"))?
}
