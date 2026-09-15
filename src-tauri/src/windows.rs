use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use tauri::{
    utils::config::WindowConfig, AppHandle, Emitter, Manager, State, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::pdfium::PdfiumState;

pub const FOCUS_DOCUMENT_EVENT: &str = "workspace://focus-document";

const CASCADE_STEP: f64 = 32.0;

/// File-manager launches steal OS focus, so routing needs the last focused app window.
pub struct AppWindows {
    next_label: AtomicU64,
    last_focused: Mutex<Option<String>>,
}

impl Default for AppWindows {
    fn default() -> Self {
        Self {
            // Reusing labels would let delayed events from a closed window target a new one.
            next_label: AtomicU64::new(2),
            last_focused: Mutex::new(None),
        }
    }
}

impl AppWindows {
    fn next_label(&self) -> String {
        format!("window-{}", self.next_label.fetch_add(1, Ordering::Relaxed))
    }
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
    let windows = app.webview_windows();

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
        .and_then(|label| app.get_webview_window(&label));

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
    // The window asked from is the frame the reader is using; a new one opens
    // that size rather than the config's first-run default. A maximized frame
    // is not one to inherit: the cascade cannot step past a whole work area,
    // and the new window would land exactly over the old one.
    if !window.is_maximized().unwrap_or(false) {
        if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
            let size = size.to_logical::<f64>(scale);

            config.width = size.width;
            config.height = size.height;
        }
    }
    cascade_from(&window, &mut config);

    WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map(|_| ())
        .map_err(|error| format!("a new window could not be opened: {error}"))
}

fn cascade_from(reference: &WebviewWindow, config: &mut WindowConfig) {
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

#[derive(Default)]
pub struct DocumentOwners(Mutex<HashMap<u64, DocumentOwner>>);

struct DocumentOwner {
    window: String,
    path: Option<PathBuf>,
}

impl DocumentOwners {
    pub fn record(&self, document_id: u64, window: &str, path: Option<PathBuf>) {
        if let Ok(mut owners) = self.0.lock() {
            owners.insert(
                document_id,
                DocumentOwner {
                    window: window.to_string(),
                    path,
                },
            );
        }
    }

    pub fn release(&self, document_id: u64) {
        if let Ok(mut owners) = self.0.lock() {
            owners.remove(&document_id);
        }
    }

    pub fn adopt_path(&self, document_id: u64, path: PathBuf) {
        if let Ok(mut owners) = self.0.lock() {
            if let Some(owner) = owners.get_mut(&document_id) {
                owner.path = Some(path);
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

    /// The caller already checked its tabs; its own match may be a close still in flight.
    fn holder_of(&self, path: &Path, asking: &str) -> Option<(String, u64)> {
        let owners = self.0.lock().ok()?;

        owners
            .iter()
            .find(|(_, owner)| owner.window != asking && owner.path.as_deref() == Some(path))
            .map(|(document_id, owner)| (owner.window.clone(), *document_id))
    }

    fn take_window(&self, window: &str) -> Vec<u64> {
        let Ok(mut owners) = self.0.lock() else {
            return Vec::new();
        };

        let mut taken = Vec::new();
        owners.retain(|document_id, owner| {
            if owner.window == window {
                taken.push(*document_id);
                false
            } else {
                true
            }
        });

        taken
    }
}

/// An open may finish after `Destroyed` has already released the window’s documents.
pub fn record_document(
    owners: &DocumentOwners,
    window: &WebviewWindow,
    document_id: u64,
    path: Option<PathBuf>,
) {
    owners.record(document_id, window.label(), path);

    let app = window.app_handle();

    if app.get_webview_window(window.label()).is_none() {
        release_window(app, window.label());
    }
}

pub fn window_gone(app: &AppHandle, label: &str) {
    release_window(app, label);
    forget_focus(app, label);
}

/// Destroy and reload cannot wait for frontend unmount handlers to close documents.
pub fn release_window(app: &AppHandle, label: &str) {
    let (Some(owners), Some(pdfium)) = (
        app.try_state::<DocumentOwners>(),
        app.try_state::<PdfiumState>(),
    ) else {
        return;
    };

    for document_id in owners.take_window(label) {
        pdfium.close_document_detached(document_id);
    }
}

/// No path approval is needed: this only checks ownership, without disk access or a save target.
#[tauri::command]
pub async fn focus_pdf_path(
    path: String,
    app: AppHandle,
    owners: State<'_, DocumentOwners>,
    window: WebviewWindow,
) -> Result<bool, String> {
    let Some((label, document_id)) = owners.holder_of(Path::new(&path), window.label()) else {
        return Ok(false);
    };

    let Some(window) = app.get_webview_window(&label) else {
        release_window(&app, &label);
        return Ok(false);
    };

    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = app.emit_to(label.as_str(), FOCUS_DOCUMENT_EVENT, document_id);

    Ok(true)
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

    #[test]
    fn sends_a_path_to_the_window_that_holds_it() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", Some(PathBuf::from("/tmp/a.pdf")));

        assert_eq!(
            owners.holder_of(Path::new("/tmp/a.pdf"), "window-2"),
            Some(("main".to_string(), 1))
        );
        assert_eq!(owners.holder_of(Path::new("/tmp/b.pdf"), "window-2"), None);
    }

    #[test]
    fn leaves_the_asking_window_its_own_documents() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", Some(PathBuf::from("/tmp/a.pdf")));

        assert_eq!(owners.holder_of(Path::new("/tmp/a.pdf"), "main"), None);
    }

    #[test]
    fn owns_only_this_window_own_documents() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", None);

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
    fn forgets_a_closed_document() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", Some(PathBuf::from("/tmp/a.pdf")));
        owners.release(1);

        assert_eq!(owners.holder_of(Path::new("/tmp/a.pdf"), "window-2"), None);
    }

    #[test]
    fn a_first_export_makes_a_document_stand_for_the_file_it_adopted() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", None);
        owners.adopt_path(1, PathBuf::from("/tmp/exported.pdf"));

        assert_eq!(
            owners.holder_of(Path::new("/tmp/exported.pdf"), "window-2"),
            Some(("main".to_string(), 1))
        );
    }

    #[test]
    fn hands_back_only_the_documents_of_the_window_that_went() {
        let owners = DocumentOwners::default();
        owners.record(1, "main", Some(PathBuf::from("/tmp/a.pdf")));
        owners.record(2, "window-2", None);
        owners.record(3, "window-2", Some(PathBuf::from("/tmp/b.pdf")));

        let mut taken = owners.take_window("window-2");
        taken.sort_unstable();

        assert_eq!(taken, vec![2, 3]);
        assert!(owners.take_window("window-2").is_empty());
        assert_eq!(
            owners.holder_of(Path::new("/tmp/a.pdf"), "window-2"),
            Some(("main".to_string(), 1))
        );
    }

    #[test]
    fn names_each_new_window_once() {
        let windows = AppWindows::default();

        assert_eq!(windows.next_label(), "window-2");
        assert_eq!(windows.next_label(), "window-3");
    }
}
