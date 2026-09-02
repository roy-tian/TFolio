use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, State,
};
use tauri_plugin_dialog::DialogExt;

use crate::recent::RecentFiles;

use super::font::{download_fallback_font, fallback_font_destination};
use super::{
    size_limit_error, ExportOutcome, InsertOutcome, MergeBookmarks, PageNumbersConfig, PagePoint,
    PagePointsRect, PdfDocumentInfo, PdfFileSummary, PdfStructureUpdate, PdfTextSpan, PdfiumState,
    RectEffect, RectStyle, TextNoteStyle, WatermarkConfig, MAX_PDF_BYTES,
};

// Only the check below reaches into the engine's own type, and the e2e build
// drops the check.
#[cfg(not(feature = "e2e"))]
use super::engine::PdfiumEngine;

/// The one approval check every path-taking command makes, in the one wording.
/// A path is a string any page code can make up, so only paths the OS produced
/// in this process's sight — a drop the window handler saw, a pick a dialog
/// returned, or one an earlier run recorded as recent — are ever acted on. The
/// e2e harness works on scratch files no dialog ever blessed, so its build
/// waives the check.
#[cfg(not(feature = "e2e"))]
fn ensure_approved(engine: &PdfiumEngine, path: &Path) -> Result<(), String> {
    if engine.is_approved(path) {
        Ok(())
    } else {
        Err(format!(
            "{} did not come from a file dialog or a drop",
            path.display()
        ))
    }
}

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
pub async fn create_pdf(state: State<'_, PdfiumState>) -> Result<PdfDocumentInfo, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.create_blank())
        .await
        .map_err(|error| format!("PDFium create task failed: {error}"))?
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
) -> Result<u64, String> {
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
) -> Result<u64, String> {
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
) -> Result<u64, String> {
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
) -> Result<u64, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.add_text_note(document_id, page_number, &origin, &text, &style)
    })
    .await
    .map_err(|error| format!("PDFium note task failed: {error}"))?
}

/// Fetches the fallback face, so text no installed font can draw has something
/// to be embedded in. Answered by the frontend's offer to download, which is
/// itself raised only by `FONT_MISSING_ERROR` coming back from an edit.
///
/// Takes nothing the WebView could shape. The host, the pinned commit, the
/// digest and the destination are all fixed in `font.rs`, so however this is
/// called it can only ever fetch that one file to that one place — a command
/// that took a URL would be an open request forwarder wearing this one's name.
#[tauri::command]
pub async fn download_pdf_note_font(app: AppHandle) -> Result<(), String> {
    let destination = fallback_font_destination(&app)
        .ok_or_else(|| "this machine has nowhere to keep a downloaded font".to_string())?;

    download_fallback_font(&destination).await
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

/// Removes marks this session made, by the ids their adds handed back — what an
/// undo and the eraser both go through. Reports the page each was on, so the
/// frontend can redraw exactly those.
#[tauri::command]
pub async fn delete_pdf_annotations(
    document_id: u64,
    mark_ids: Vec<u64>,
    state: State<'_, PdfiumState>,
) -> Result<Vec<i32>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.delete_marks(document_id, &mark_ids))
        .await
        .map_err(|error| format!("PDFium annotation removal task failed: {error}"))?
}

/// The mark under a point on a page, for the eraser to aim at — `None` where
/// the reader pointed at nothing of this session's.
#[tauri::command]
pub async fn pdf_annotation_at_point(
    document_id: u64,
    page_number: i32,
    point: PagePoint,
    state: State<'_, PdfiumState>,
) -> Result<Option<u64>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        engine.mark_at_point(document_id, page_number, &point)
    })
    .await
    .map_err(|error| format!("PDFium annotation hit test task failed: {error}"))?
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
    recent: State<'_, RecentFiles>,
) -> Result<PdfDocumentInfo, String> {
    let engine = Arc::clone(&state.0);
    let recent = recent.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);

        // Opening a path binds it as the file `save_pdf` will overwrite, which
        // is why an unapproved one is refused — see `ensure_approved`.
        #[cfg(not(feature = "e2e"))]
        ensure_approved(&engine, &path)?;

        let document = engine.open_from_path(path.clone())?;
        // Recorded only once the file actually opened, so the list the next
        // run approves holds nothing this one could not open itself.
        recent.record(&path);

        Ok(document)
    })
    .await
    .map_err(|error| format!("PDFium open task failed: {error}"))?
}

#[tauri::command]
pub async fn insert_pdf_from_path(
    document_id: u64,
    path: String,
    index: i32,
    state: State<'_, PdfiumState>,
) -> Result<InsertOutcome, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);

        // The same approval a fresh open needs, and for the same reason: an
        // insert reads a file the WebView named.
        #[cfg(not(feature = "e2e"))]
        ensure_approved(&engine, &path)?;

        engine.insert_from_path(document_id, path, index)
    })
    .await
    .map_err(|error| format!("PDFium insert task failed: {error}"))?
}

/// Shows the native open dialog in multi-select mode, for the merge wizard's
/// file list. Every chosen path is recorded as approved, exactly as the
/// single-file pick does — see `pick_pdf_path`.
#[tauri::command]
pub async fn pick_pdf_paths(
    filter_label: String,
    app: AppHandle,
    state: State<'_, PdfiumState>,
) -> Result<Vec<String>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter(filter_label, &["pdf"])
            .blocking_pick_files()
        else {
            return Ok(Vec::new());
        };

        let paths = picked
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|error| format!("a chosen file is unusable: {error}"))
            })
            .collect::<Result<Vec<PathBuf>, _>>()?;

        engine.approve_paths(paths.iter());

        Ok(paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|error| format!("dialog task failed: {error}"))?
}

/// Reports what each candidate file of a merge holds, so the wizard's first
/// step can show page counts and total the result up before anything is merged.
#[tauri::command]
pub async fn inspect_pdf_files(
    paths: Vec<String>,
    state: State<'_, PdfiumState>,
) -> Result<Vec<PdfFileSummary>, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

        // Reading a file the WebView merely named would let a page learn what
        // any PDF on the disk holds, so an inspection is approved like an open.
        #[cfg(not(feature = "e2e"))]
        for path in &paths {
            ensure_approved(&engine, path)?;
        }

        engine.inspect_files(paths)
    })
    .await
    .map_err(|error| format!("PDFium inspection task failed: {error}"))?
}

/// Merges the named files, in order, into one new document — the merge
/// wizard's whole backend half. The result has no source path, so it can only
/// ever be exported to a copy: nothing it merged can be written back over.
#[tauri::command]
pub async fn merge_pdf_files(
    paths: Vec<String>,
    smart_padding: bool,
    bookmarks: MergeBookmarks,
    state: State<'_, PdfiumState>,
) -> Result<PdfDocumentInfo, String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

        // The same approval a fresh open needs, for the same reason a merge into
        // an open document needs it: a merge reads files the WebView named.
        #[cfg(not(feature = "e2e"))]
        for path in &paths {
            ensure_approved(&engine, path)?;
        }

        engine.merge_files(paths, smart_padding, bookmarks)
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
