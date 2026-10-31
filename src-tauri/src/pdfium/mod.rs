mod archive;
mod commands;
mod compress;
mod encode;
mod organize;
mod paths;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::AppHandle;
use tfolio_engine::{PdfiumEngine, WordSuites};

pub use archive::{cancel_pdf_archive, export_pdf_archive};
#[cfg(feature = "e2e")]
pub use commands::export_pdf_to;
pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_merge,
    cancel_pdf_operation, cancel_pdf_search, cancel_word_conversion, cancel_word_open, close_pdf,
    create_pdf, delete_pdf_annotations, delete_pdf_pages, discard_pdf_stashes,
    download_pdf_note_font, duplicate_pdf_pages, export_pdf, extract_pdf_page_plain_text,
    extract_pdf_page_text, insert_pdf_blank_page, open_converted_from_path, open_pdf,
    open_pdf_from_path, pdf_annotation_at_point, pdf_text_note_font, pick_pdf_path, pick_pdf_paths,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    render_pdf_watermark_preview, reorder_pdf_pages, restore_pdf_pages, rotate_pdf_pages, save_pdf,
    search_pdf_text, word_conversion_available,
};
pub use compress::{
    cancel_pdf_compression, cancel_pdf_compression_estimate, estimate_pdf_compression,
    export_compressed_pdf, release_pdf_compression,
};
pub use organize::{add_organize_sources, assemble_pdf, render_organize_thumbnail};

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
pub struct PdfiumState {
    engine: Arc<PdfiumEngine>,
    /// Paths something outside the WebView produced — a drop, a dialog pick. A
    /// path is a string any page code can make up, and opening one binds a save.
    approved: Arc<Mutex<HashSet<PathBuf>>>,
}

impl PdfiumState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        // The GUI suite must not depend on what the machine running it has installed.
        let word_suites = if cfg!(feature = "e2e") {
            WordSuites::Absent
        } else {
            WordSuites::Installed
        };

        Ok(Self {
            engine: Arc::new(PdfiumEngine::new(paths::engine_paths(app), word_suites)?),
            approved: Arc::default(),
        })
    }

    pub fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        if let Ok(mut approved) = self.approved.lock() {
            approved.extend(paths.into_iter().cloned());
        }
    }

    /// Kept rather than consumed: the reader may cancel the unsaved guard and
    /// open the same file again; the e2e build waives the check at call sites.
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    fn is_approved(&self, path: &Path) -> bool {
        self.approved
            .lock()
            .map(|approved| approved.contains(path))
            .unwrap_or(false)
    }

    /// Whether a source may be a Word document: the machine's own
    /// suites, detected passively — never a reader setting.
    fn word_available(&self) -> bool {
        // E2e answers yes with no suite behind it, so specs can drive the row
        // a refused conversion leaves; a closed door would never show it.
        cfg!(feature = "e2e") || self.engine.word_conversion_available()
    }

    /// A window's label is the engine's cancellation scope for its merge and
    /// Word conversions.
    pub fn cancel_window_work(&self, label: &str) {
        self.engine.cancel_scope_work(label);
    }

    /// A window's organize sources go with it. Dropping them is PDFium work,
    /// which must not block the window event loop. Only after
    /// `cancel_window_work`, which stops an add from keeping a source after this.
    pub fn release_window_sources(&self, label: &str) {
        let engine = Arc::clone(&self.engine);
        let label = label.to_string();
        // Taken now, not when the lock is free: by then a reloaded page may
        // have added sources of its own under the same label.
        let before = engine.organize_release_cutoff();

        tauri::async_runtime::spawn_blocking(move || engine.release_organize_scope(&label, before));
    }

    pub fn remove_conversion_files(&self) {
        self.engine.remove_conversion_files();
    }

    /// Closing takes the PDFium lock, so it must not block the window event loop.
    pub fn close_document_detached(&self, document_id: u64) {
        let engine = Arc::clone(&self.engine);
        engine.cancel_document_work(document_id);

        tauri::async_runtime::spawn_blocking(move || {
            let _ = engine.close(document_id);
        });
    }
}
