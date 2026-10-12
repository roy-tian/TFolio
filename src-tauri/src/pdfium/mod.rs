mod archive;
mod commands;
mod compress;
mod paths;

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use tauri::AppHandle;
use tfolio_engine::PdfiumEngine;

pub use archive::{cancel_pdf_archive, export_pdf_archive};
#[cfg(feature = "e2e")]
pub use commands::export_pdf_to;
pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_merge,
    cancel_pdf_operation, cancel_pdf_search, cancel_word_conversion, cancel_word_open, close_pdf,
    create_pdf, delete_pdf_annotations, delete_pdf_pages, discard_pdf_stashes,
    download_pdf_note_font, duplicate_pdf_pages, export_pdf, extract_pdf_page_plain_text,
    extract_pdf_page_text, insert_pdf_blank_page, insert_pdf_from_path,
    insert_pdf_pages_from_document, inspect_pdf_files, merge_pdf_files, open_converted_from_path,
    open_pdf, open_pdf_from_path, pdf_annotation_at_point, pdf_text_note_font, pick_pdf_path,
    pick_pdf_paths, remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page,
    render_pdf_page_thumbnail, render_pdf_watermark_preview, reorder_pdf_pages, restore_pdf_pages,
    rotate_pdf_pages, save_pdf, search_pdf_text, word_conversion_available,
};
pub use compress::{
    cancel_pdf_compression, cancel_pdf_compression_estimate, estimate_pdf_compression,
    export_compressed_pdf, release_pdf_compression,
};

/// Counts work units rather than bytes: pages for owned content, and
/// source/finishing stages for a merge.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfProgress {
    completed: usize,
    total: usize,
}

impl PdfProgress {
    fn new(completed: usize, total: usize) -> Self {
        Self { completed, total }
    }
}

#[derive(Clone)]
pub struct PdfiumState(Arc<PdfiumEngine>);

impl PdfiumState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        PdfiumEngine::new(paths::engine_paths(app)).map(|engine| Self(Arc::new(engine)))
    }

    pub fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        self.0.approve_paths(paths);
    }

    pub fn cancel_window_work(&self, label: &str) {
        self.0.cancel_window_work(label);
    }

    pub fn remove_conversion_files(&self) {
        self.0.remove_conversion_files();
    }

    /// Closing takes the PDFium lock, so it must not block the window event loop.
    pub fn close_document_detached(&self, document_id: u64) {
        let engine = Arc::clone(&self.0);
        engine.cancel_document_work(document_id);

        tauri::async_runtime::spawn_blocking(move || {
            let _ = engine.close(document_id);
        });
    }
}
