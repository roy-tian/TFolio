use std::{path::Path, sync::Arc};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    State,
};

use super::{
    PagePoint, PagePointsRect, PdfDocumentInfo, PdfTextSpan, PdfiumState, RectStyle, TextNoteStyle,
    MAX_PDF_BYTES,
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
        return Err(format!(
            "PDF file exceeds the {} MiB limit",
            MAX_PDF_BYTES / 1024 / 1024
        ));
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
pub async fn export_pdf(
    document_id: u64,
    path: String,
    state: State<'_, PdfiumState>,
) -> Result<(), String> {
    let engine = Arc::clone(&state.0);

    tauri::async_runtime::spawn_blocking(move || engine.save_to(document_id, Path::new(&path)))
        .await
        .map_err(|error| format!("PDFium save task failed: {error}"))?
}

#[tauri::command]
pub fn close_pdf(document_id: u64, state: State<'_, PdfiumState>) -> Result<(), String> {
    state.0.close(document_id)
}
