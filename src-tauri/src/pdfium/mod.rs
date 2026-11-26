mod a4;
mod archive;
mod commands;
mod compress;
mod encode;
mod files;
mod paths;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tfolio_engine::{PdfiumEngine, WordSuites};

pub use a4::fit_a4_pdf;
pub use archive::{cancel_pdf_archive, export_pdf_archive};
#[cfg(feature = "e2e")]
pub use commands::export_pdf_to;
pub use commands::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark,
    cancel_pdf_operation, cancel_pdf_search, cancel_word_conversion, cancel_word_open, close_pdf,
    create_pdf, decide_pdf_signatures, delete_pdf_annotations, delete_pdf_pages,
    discard_pdf_stashes, download_pdf_note_font, duplicate_pdf_pages, export_pdf,
    extract_pdf_page_plain_text, extract_pdf_page_text, extract_pdf_pages, flatten_pdf_signatures,
    insert_pdf_blank_page, insert_pdf_pages_from_document, open_converted_from_path, open_pdf,
    open_pdf_from_path, pdf_annotation_at_point, pdf_file_changed, pdf_text_note_font,
    pick_pdf_path, pick_pdf_paths, remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page,
    render_pdf_page_thumbnail, render_pdf_watermark_preview, reorder_pdf_pages,
    restore_pdf_page_numbers, restore_pdf_pages, rotate_pdf_pages, save_pdf, search_pdf_text,
    word_conversion_available,
};
pub use compress::{
    cancel_pdf_compression, cancel_pdf_compression_estimate, estimate_pdf_compression,
    export_compressed_pdf, release_pdf_compression,
};
#[cfg(feature = "e2e")]
pub use files::unload_pdf_sources;
pub use files::{
    insert_pdf_files, merge_pdf_sources, read_pdf_sources, release_pdf_sources, rename_pdf_section,
    set_pdf_file_options, source_sizes,
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

/// Distinct from user cancellation (`Ok(None)`), so export modals stay open
/// with the reader's choices intact instead of dismissing.
pub(super) const FILE_DIALOG_BUSY: &str = "file-dialog-busy";

pub(super) enum DialogOutcome<T> {
    Picked(T),
    Cancelled,
    Busy,
}

/// Keeps at most one native file dialog open per window: on Linux GTK3
/// `rfd` ignores the parent handle, and even with one a second press before
/// the OS dialog takes focus could otherwise queue or open another.
#[derive(Clone, Default)]
struct FileDialogGate(Arc<Mutex<HashSet<String>>>);

impl FileDialogGate {
    fn acquire(&self, window_label: &str) -> Option<FileDialogGuard> {
        let mut open = self.0.lock().ok()?;

        if !open.insert(window_label.to_string()) {
            return None;
        }

        Some(FileDialogGuard {
            open: Arc::clone(&self.0),
            window_label: window_label.to_string(),
        })
    }
}

struct FileDialogGuard {
    open: Arc<Mutex<HashSet<String>>>,
    window_label: String,
}

impl Drop for FileDialogGuard {
    fn drop(&mut self) {
        if let Ok(mut open) = self.open.lock() {
            open.remove(&self.window_label);
        }
    }
}

#[derive(Clone)]
pub struct PdfiumState {
    engine: Arc<PdfiumEngine>,
    /// Paths something outside the WebView produced — a drop, a dialog pick. A
    /// path is a string any page code can make up, and opening one binds a save.
    approved: Arc<Mutex<HashSet<PathBuf>>>,
    dialogs: FileDialogGate,
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
            dialogs: FileDialogGate::default(),
        })
    }

    /// Runs one native file dialog per window off the main thread, parenting it
    /// to `window` and releasing the per-window gate as soon as the dialog closes
    /// (never holding it across the follow-up open or export work).
    pub(super) async fn run_file_dialog<T, F>(
        &self,
        window: &WebviewWindow,
        open: F,
    ) -> Result<DialogOutcome<T>, String>
    where
        T: Send + 'static,
        F: FnOnce(FileDialogBuilder<tauri::Wry>) -> Option<T> + Send + 'static,
    {
        let Some(_guard) = self.dialogs.acquire(window.label()) else {
            return Ok(DialogOutcome::Busy);
        };
        let window = window.clone();

        // `blocking_*` dialogs would deadlock the main thread outside `spawn_blocking`.
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = _guard;
            let dialog = window.app_handle().dialog().file().set_parent(&window);

            match open(dialog) {
                Some(picked) => DialogOutcome::Picked(picked),
                None => DialogOutcome::Cancelled,
            }
        })
        .await
        .map_err(|error| format!("dialog task failed: {error}"))
    }

    pub fn approve_paths<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        if let Ok(mut approved) = self.approved.lock() {
            approved.extend(paths.into_iter().cloned());
        }
    }

    /// Kept rather than consumed: the reader may cancel the unsaved guard and
    /// open the same file again; the e2e build waives the check at call sites.
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    pub(crate) fn is_approved(&self, path: &Path) -> bool {
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

    /// A window's file sources go with it. Dropping them is PDFium work,
    /// which must not block the window event loop. Only after
    /// `cancel_window_work`, which stops an add from keeping a source after this.
    pub fn release_window_sources(&self, label: &str) {
        let engine = Arc::clone(&self.engine);
        let label = label.to_string();
        // Taken now, not when the lock is free: by then a reloaded page may
        // have added sources of its own under the same label.
        let before = engine.source_release_cutoff();

        tauri::async_runtime::spawn_blocking(move || engine.release_source_scope(&label, before));
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

#[cfg(test)]
mod tests {
    use super::FileDialogGate;

    #[test]
    fn file_dialog_gate_allows_one_dialog_per_window_at_a_time() {
        let gate = FileDialogGate::default();
        let main = gate.acquire("main");

        assert!(main.is_some());
        assert!(gate.acquire("main").is_none());

        let second_window = gate.acquire("window-2");
        assert!(second_window.is_some());

        drop(main);
        assert!(gate.acquire("main").is_some());
    }
}
