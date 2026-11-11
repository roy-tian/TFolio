use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde::Serialize;
use tauri::{
    utils::config::WindowConfig, AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder,
};
use tfolio_engine::FileKey;

use crate::handoff::{return_pending, HandoffQueue};
use crate::launch::reroute_launches;
use crate::pdfium::PdfiumState;

/// Carries the document id; spelled again in `App.tsx`, which listens for it.
pub const REOPEN_DOCUMENT_EVENT: &str = "workspace://reopen-document";

const CASCADE_STEP: f64 = 32.0;

/// File-manager launches steal OS focus, so routing needs the last focused app window.
pub struct AppWindows {
    next_label: AtomicU64,
    last_focused: Mutex<Option<String>>,
    pages: Mutex<HashMap<String, u64>>,
}

impl Default for AppWindows {
    fn default() -> Self {
        Self {
            // Reusing labels would let delayed events from a closed window target a new one.
            next_label: AtomicU64::new(2),
            last_focused: Mutex::new(None),
            pages: Mutex::new(HashMap::new()),
        }
    }
}

/// Which of a window's page loads a command started under. A reload releases
/// the window's documents as the new page starts, so a document an older page
/// asked for would land in a page that no longer knows of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageGeneration(u64);

impl AppWindows {
    fn next_label(&self) -> String {
        format!("window-{}", self.next_label.fetch_add(1, Ordering::Relaxed))
    }

    fn page(&self, label: &str) -> PageGeneration {
        PageGeneration(
            self.pages
                .lock()
                .ok()
                .and_then(|pages| pages.get(label).copied())
                .unwrap_or(0),
        )
    }

    fn start_page(&self, label: &str) {
        if let Ok(mut pages) = self.pages.lock() {
            *pages.entry(label.to_string()).or_insert(0) += 1;
        }
    }

    fn forget_page(&self, label: &str) {
        if let Ok(mut pages) = self.pages.lock() {
            pages.remove(label);
        }
    }
}

/// Captured when a command that opens a document starts, for `record_document`.
pub fn page_generation(window: &WebviewWindow) -> PageGeneration {
    window
        .try_state::<AppWindows>()
        .map(|windows| windows.page(window.label()))
        .unwrap_or(PageGeneration(0))
}

/// The page before this one is gone with everything it held: counted first,
/// so an open still in flight from it sees the change when it lands.
pub fn page_started(app: &AppHandle, label: &str) {
    if let Some(windows) = app.try_state::<AppWindows>() {
        windows.start_page(label);
    }

    release_window(app, label);
}

pub fn remember_focus(app: &AppHandle, label: &str) {
    set_last_focused(app, |_| Some(label.to_string()));
}

fn forget_focus(app: &AppHandle, label: &str) {
    set_last_focused(app, |remembered| remembered.filter(|last| last != label));
}

fn set_last_focused(app: &AppHandle, next: impl FnOnce(Option<String>) -> Option<String>) {
    let Some(windows) = app.try_state::<AppWindows>() else {
        return;
    };
    let Ok(mut last_focused) = windows.last_focused.lock() else {
        return;
    };

    *last_focused = next(last_focused.take());
}

pub fn focus_target(app: &AppHandle) -> Option<WebviewWindow> {
    focus_target_except(app, None)
}

/// A window whose `Destroyed` is running may still be listed, and must not be
/// the answer for what it leaves behind.
pub fn focus_target_except(app: &AppHandle, gone: Option<&str>) -> Option<WebviewWindow> {
    let mut windows = app.webview_windows();

    if let Some(gone) = gone {
        windows.remove(gone);
    }

    if let Some(focused) = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        return Some(focused.clone());
    }

    let last_focused = app
        .try_state::<AppWindows>()
        .and_then(|state| -> Option<String> {
            let last_focused = state.last_focused.lock().ok()?;
            last_focused.clone()
        })
        .and_then(|label| windows.get(&label).cloned());

    if last_focused.is_some() {
        return last_focused;
    }

    // Sorting prefers `main` and keeps the fallback independent of HashMap iteration order.
    windows
        .into_iter()
        .min_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, window)| window)
}

#[tauri::command]
pub async fn open_new_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let mut config = window_config_from(&app, &window)?;
    cascade_from(&window, &mut config);

    WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map(|_| ())
        .map_err(|error| format!("a new window could not be opened: {error}"))
}

/// The config any new window opens from: the configured first window's chrome,
/// a label of its own, and the asking window's size — a maximized frame is not
/// one to inherit: the cascade cannot step past a whole work area, and the new
/// window would land exactly over the old one.
pub fn window_config_from(
    app: &AppHandle,
    reference: &WebviewWindow,
) -> Result<WindowConfig, String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "there is no configured window to copy".to_string())?;

    config.label = app.state::<AppWindows>().next_label();
    // `visible: false` in the config is main's alone, waiting for its stored
    // frame; a window built here has nothing waiting to show it.
    config.visible = true;

    if !reference.is_maximized().unwrap_or(false) {
        if let (Ok(size), Ok(scale)) = (reference.inner_size(), reference.scale_factor()) {
            let size = size.to_logical::<f64>(scale);

            config.width = size.width;
            config.height = size.height;
        }
    }

    Ok(config)
}

pub fn cascade_from(reference: &WebviewWindow, config: &mut WindowConfig) {
    let (Ok(scale), Ok(position)) = (reference.scale_factor(), reference.outer_position()) else {
        return;
    };

    let position = position.to_logical::<f64>(scale);
    let mut x = position.x + CASCADE_STEP;
    let mut y = position.y + CASCADE_STEP;

    // Wrap axes independently so a full-height window can still cascade horizontally.
    if let Ok(Some(monitor)) = reference.current_monitor() {
        let area = monitor.work_area();
        let origin = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);

        if x + config.width > origin.x + size.width {
            x = origin.x;
        }

        if y + config.height > origin.y + size.height {
            y = origin.y;
        }
    }

    config.center = false;
    config.x = Some(x);
    config.y = Some(y);
}

/// The file on disk a document stands for: what an open of that file again
/// finds it by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentFile {
    /// Blank, extracted, or not written yet: no path finds it.
    None,
    /// The file a save writes back over.
    Bound(PathBuf),
    /// The image or Word file it was converted from, until a Save As binds it.
    Converted(PathBuf),
}

impl DocumentFile {
    fn path(&self) -> Option<&Path> {
        match self {
            Self::None => None,
            Self::Bound(path) | Self::Converted(path) => Some(path),
        }
    }
}

#[derive(Default)]
pub struct DocumentOwners(Mutex<HashMap<u64, DocumentOwner>>);

struct DocumentOwner {
    window: String,
    file: DocumentFile,
}

impl DocumentOwners {
    pub fn record(&self, document_id: u64, window: &str, file: DocumentFile) {
        if let Ok(mut owners) = self.0.lock() {
            owners.insert(
                document_id,
                DocumentOwner {
                    window: window.to_string(),
                    file,
                },
            );
        }
    }

    /// Checks the page after recording, never before: a reload counted
    /// between the two is then seen here, or its release finds the record.
    fn record_for_page(
        &self,
        windows: &AppWindows,
        label: &str,
        page: PageGeneration,
        document_id: u64,
        file: DocumentFile,
    ) -> bool {
        self.record(document_id, label, file);

        if windows.page(label) == page {
            return true;
        }

        self.release(document_id);
        false
    }

    pub fn release(&self, document_id: u64) {
        if let Ok(mut owners) = self.0.lock() {
            owners.remove(&document_id);
        }
    }

    pub fn adopt_path(&self, document_id: u64, path: PathBuf) {
        if let Ok(mut owners) = self.0.lock() {
            if let Some(owner) = owners.get_mut(&document_id) {
                owner.file = DocumentFile::Bound(path);
            }
        }
    }

    /// Ownership is per window: a command touching two documents at once — a
    /// page drag between grids — must find both in the window that asked.
    pub fn owns(&self, document_id: u64, window: &str) -> bool {
        self.0.lock().is_ok_and(|owners| {
            owners
                .get(&document_id)
                .is_some_and(|owner| owner.window == window)
        })
    }

    /// Moves a document to another window whole, under one lock, or not at all:
    /// `None` means the sending window did not hold it. The answer is the file
    /// the record keeps standing for, which the move carries beside its payload.
    pub fn transfer(&self, document_id: u64, from: &str, to: &str) -> Option<DocumentFile> {
        let mut owners = self.0.lock().ok()?;

        let owner = owners.get_mut(&document_id)?;

        if owner.window != from {
            return None;
        }

        owner.window = to.to_string();
        Some(owner.file.clone())
    }

    /// Every window and document standing for the file at `path`, matched by
    /// identity. The disk is read off the lock, which every command's
    /// ownership check waits on.
    fn holders_of(&self, path: &Path) -> Vec<(String, u64)> {
        let Ok(owners) = self.0.lock() else {
            return Vec::new();
        };
        let files: Vec<(String, u64, PathBuf)> = owners
            .iter()
            .filter_map(|(document_id, owner)| {
                let file = owner.file.path()?;

                Some((owner.window.clone(), *document_id, file.to_path_buf()))
            })
            .collect();
        drop(owners);

        let asked = FileKey::of(path);

        files
            .into_iter()
            .filter(|(_, _, file)| FileKey::of(file).names_same_file(&asked))
            .map(|(window, document_id, _)| (window, document_id))
            .collect()
    }

    /// The ids a window stood for, minus the kept ones, which stay standing:
    /// a handoff still waiting on the window keeps its record, so the take
    /// after a reload completes the move rather than the close a destroy does.
    fn take_window_except(&self, window: &str, keep: &[u64]) -> Vec<u64> {
        let Ok(mut owners) = self.0.lock() else {
            return Vec::new();
        };

        let mut taken = Vec::new();
        owners.retain(|document_id, owner| {
            if owner.window == window && !keep.contains(document_id) {
                taken.push(*document_id);
                false
            } else {
                true
            }
        });

        taken
    }
}

/// An open may finish after `Destroyed` or a reload has already released the
/// window’s documents; then it closes what it opened rather than leak it.
pub fn record_document(
    owners: &DocumentOwners,
    window: &WebviewWindow,
    page: PageGeneration,
    document_id: u64,
    file: DocumentFile,
) {
    let app = window.app_handle();
    let recorded = app.try_state::<AppWindows>().is_none_or(|windows| {
        owners.record_for_page(&windows, window.label(), page, document_id, file)
    });

    if !recorded {
        if let Some(pdfium) = app.try_state::<PdfiumState>() {
            pdfium.close_document_detached(document_id);
        }
    } else if app.get_webview_window(window.label()).is_none() {
        window_gone(app, window.label());
    }
}

pub fn window_gone(app: &AppHandle, label: &str) {
    // Untaken handoffs first: their documents go home rather than under.
    return_pending(app, label);
    release_window(app, label);
    forget_focus(app, label);
    reroute_launches(app, label);

    if let Some(windows) = app.try_state::<AppWindows>() {
        windows.forget_page(label);
    }
}

/// Destroy and reload cannot wait for frontend unmount handlers to close
/// documents, nor stop the merge or conversion the page was waiting on.
/// A handoff still waiting on this window keeps its documents: the window is
/// only reloading, and its take after boot completes what the move began.
fn release_window(app: &AppHandle, label: &str) {
    let (Some(owners), Some(pdfium)) = (
        app.try_state::<DocumentOwners>(),
        app.try_state::<PdfiumState>(),
    ) else {
        return;
    };

    pdfium.cancel_window_work(label);
    pdfium.release_window_sources(label);

    let pending = app
        .try_state::<HandoffQueue>()
        .map(|handoff| handoff.pending_ids(label))
        .unwrap_or_default();

    for document_id in owners.take_window_except(label, &pending) {
        pdfium.close_document_detached(document_id);
    }
}

/// Where a file asked to open already is.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenFileHolder {
    None,
    /// One of the asking window's own tabs.
    #[serde(rename_all = "camelCase")]
    Here {
        document_id: u64,
    },
    /// Another window's, brought forward to take the open itself.
    Elsewhere,
}

/// The asker's own live tab first: its records may include a close still in
/// flight, which `tab_ids` leaves out.
fn pick_holder(holders: &[(String, u64)], asking: &str, tab_ids: &[u64]) -> Option<OpenFileHolder> {
    holders
        .iter()
        .find(|(window, document_id)| window == asking && tab_ids.contains(document_id))
        .map(|(_, document_id)| OpenFileHolder::Here {
            document_id: *document_id,
        })
}

/// Two documents over one file would each save over the other's edits, so an
/// alias of an open file — another spelling, a link, a different case — finds
/// the document already standing for it. The path is read for its identity,
/// so it needs approval like the open it precedes.
#[tauri::command]
pub async fn find_open_file(
    path: String,
    tab_ids: Vec<u64>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<OpenFileHolder, String> {
    let path = PathBuf::from(path);

    #[cfg(not(feature = "e2e"))]
    if !app.state::<PdfiumState>().is_approved(&path) {
        return Ok(OpenFileHolder::None);
    }

    let lookup = app.clone();
    let holders = tauri::async_runtime::spawn_blocking(move || {
        lookup.state::<DocumentOwners>().holders_of(&path)
    })
    .await
    .map_err(|error| format!("open file lookup failed: {error}"))?;
    let asking = window.label();

    if let Some(here) = pick_holder(&holders, asking, &tab_ids) {
        return Ok(here);
    }

    for (label, document_id) in holders.into_iter().filter(|(label, _)| label != asking) {
        let Some(holder) = app.get_webview_window(&label) else {
            window_gone(&app, &label);
            continue;
        };

        let _ = holder.unminimize();
        let _ = holder.set_focus();
        let _ = app.emit_to(label.as_str(), REOPEN_DOCUMENT_EVENT, document_id);

        return Ok(OpenFileHolder::Elsewhere);
    }

    Ok(OpenFileHolder::None)
}

/// The dialog's nested loop must run on the event loop, not inside a
/// main-thread command; it outlives this call, and no signal reports its end.
#[tauri::command]
pub async fn print_window(window: WebviewWindow) -> Result<(), String> {
    window
        .print()
        .map_err(|error| format!("the print dialog could not be opened: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound(path: &str) -> DocumentFile {
        DocumentFile::Bound(PathBuf::from(path))
    }

    /// Real files in a directory of their own, so every platform resolves them.
    fn scratch_files(label: &str, names: &[&str]) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("tfolio-owners-{}-{label}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();

        for name in names {
            std::fs::write(directory.join(name), name.as_bytes()).unwrap();
        }

        directory
    }

    #[test]
    fn finds_a_file_by_any_spelling_of_it() {
        let directory = scratch_files("spellings", &["a.pdf", "b.pdf"]);
        let owners = DocumentOwners::default();
        owners.record(1, "main", DocumentFile::Bound(directory.join("a.pdf")));
        owners.record(2, "window-2", DocumentFile::None);

        let main = vec![("main".to_string(), 1)];
        assert_eq!(owners.holders_of(&directory.join("a.pdf")), main);
        assert_eq!(owners.holders_of(&directory.join(".").join("a.pdf")), main);
        assert!(owners.holders_of(&directory.join("b.pdf")).is_empty());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_converted_document_answers_for_its_source_until_save_as_binds_it() {
        let directory = scratch_files("converted", &["photo.png", "photo.pdf"]);
        let owners = DocumentOwners::default();
        owners.record(
            1,
            "main",
            DocumentFile::Converted(directory.join("photo.png")),
        );

        assert_eq!(
            owners.holders_of(&directory.join("photo.png")),
            vec![("main".to_string(), 1)]
        );

        owners.adopt_path(1, directory.join("photo.pdf"));
        assert!(owners.holders_of(&directory.join("photo.png")).is_empty());
        assert_eq!(
            owners.holders_of(&directory.join("photo.pdf")),
            vec![("main".to_string(), 1)]
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_asker_finds_only_its_own_live_tabs_here() {
        let holders = vec![("window-2".to_string(), 4), ("main".to_string(), 1)];

        assert_eq!(
            pick_holder(&holders, "main", &[1, 2]),
            Some(OpenFileHolder::Here { document_id: 1 })
        );
        assert_eq!(
            pick_holder(&holders, "main", &[2]),
            None,
            "a tab already closing is not where the file is"
        );
        assert_eq!(pick_holder(&holders, "window-3", &[4]), None);
    }

    #[test]
    fn owns_only_this_window_own_documents() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", DocumentFile::None);

        assert!(owners.owns(1, "main"));
        assert!(!owners.owns(1, "window-2"));
        assert!(
            !owners.owns(2, "main"),
            "a document nobody opened is nobody's"
        );

        owners.release(1);
        assert!(!owners.owns(1, "main"), "a closed document is nobody's");
    }

    #[test]
    fn a_first_export_makes_a_document_stand_for_the_file_it_adopted() {
        let directory = scratch_files("adopted", &["exported.pdf"]);
        let owners = DocumentOwners::default();
        owners.record(1, "main", DocumentFile::None);
        owners.adopt_path(1, directory.join("exported.pdf"));

        assert_eq!(
            owners.holders_of(&directory.join("exported.pdf")),
            vec![("main".to_string(), 1)]
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn hands_back_only_the_documents_of_the_window_that_went() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", bound("/tmp/a.pdf"));
        owners.record(2, "window-2", DocumentFile::None);
        owners.record(3, "window-2", bound("/tmp/b.pdf"));

        let mut taken = owners.take_window_except("window-2", &[]);
        taken.sort_unstable();

        assert_eq!(taken, vec![2, 3]);
        assert!(owners.take_window_except("window-2", &[]).is_empty());
        assert!(owners.owns(1, "main"));
    }

    #[test]
    fn a_release_keeps_what_a_handoff_is_still_waiting_on() {
        let owners = DocumentOwners::default();
        owners.record(1, "window-2", bound("/tmp/a.pdf"));
        owners.record(2, "window-2", DocumentFile::None);
        owners.record(3, "window-2", DocumentFile::None);

        assert_eq!(owners.take_window_except("window-2", &[1, 3]), vec![2]);
        assert!(owners.owns(1, "window-2"), "the pending handoff stands");
        assert!(owners.owns(3, "window-2"), "the pending handoff stands");
        assert!(!owners.owns(2, "window-2"), "the rest went");
    }

    #[test]
    fn a_transfer_moves_only_what_the_sender_holds() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", bound("/tmp/a.pdf"));

        assert_eq!(
            owners.transfer(1, "main", "window-2"),
            Some(bound("/tmp/a.pdf"))
        );
        assert!(owners.owns(1, "window-2"));
        assert!(!owners.owns(1, "main"));

        // The record now answers to window-2 alone; main cannot send it again.
        assert_eq!(owners.transfer(1, "main", "window-3"), None);
        assert!(owners.owns(1, "window-2"));

        // A path-less document moves the same, carrying its emptiness.
        owners.record(2, "main", DocumentFile::None);
        assert_eq!(
            owners.transfer(2, "main", "window-2"),
            Some(DocumentFile::None)
        );

        // Nobody's document goes nowhere.
        assert_eq!(owners.transfer(7, "main", "window-2"), None);
    }

    #[test]
    fn a_document_landing_after_a_reload_is_not_recorded() {
        let windows = AppWindows::default();
        let owners = DocumentOwners::default();
        windows.start_page("main");

        let page = windows.page("main");
        assert!(owners.record_for_page(&windows, "main", page, 1, DocumentFile::None));
        assert!(owners.owns(1, "main"));

        windows.start_page("main");
        assert!(
            !owners.record_for_page(&windows, "main", page, 2, DocumentFile::None),
            "the page that asked for it is gone"
        );
        assert!(!owners.owns(2, "main"));
        assert!(owners.owns(1, "main"), "a record made earlier stands");
    }

    #[test]
    fn counts_each_window_s_pages_apart() {
        let windows = AppWindows::default();
        windows.start_page("main");
        let main = windows.page("main");

        windows.start_page("window-2");
        assert_eq!(windows.page("main"), main);

        windows.forget_page("main");
        assert_ne!(windows.page("main"), main);
    }

    #[test]
    fn names_each_new_window_once() {
        let windows = AppWindows::default();

        assert_eq!(windows.next_label(), "window-2");
        assert_eq!(windows.next_label(), "window-3");
    }
}
