//! Quitting asks once, in the window the reader is using, about every window's
//! unsaved work; each window then closes itself, as its own close button would.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use crate::windows::focus_target;

/// What the menu's Quit asks of the window the reader is using: the unsaved
/// check across windows, and the prompt. Spelled again in `App.tsx`.
#[cfg(target_os = "macos")]
pub const QUIT_REQUESTED_EVENT: &str = "app://quit-requested";

/// Every window's order to close without asking again — the asking window
/// already did, for all of them. Spelled again in `App.tsx`.
pub const QUIT_EVENT: &str = "app://quit";

/// Long enough for every window to write its reading positions and go; a
/// window that cannot answer (reloading, hung) must not keep the app alive.
const QUIT_GRACE: Duration = Duration::from_secs(3);

#[cfg(target_os = "macos")]
pub const QUIT_MENU_ID: &str = "tfolio-quit";

#[cfg(target_os = "macos")]
pub fn request_quit(app: &AppHandle) {
    match focus_target(app) {
        Some(window) => {
            let _ = app.emit_to(window.label(), QUIT_REQUESTED_EVENT, ());
        }
        None => app.exit(0),
    }
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    for label in app.webview_windows().into_keys() {
        let _ = app.emit_to(label.as_str(), QUIT_EVENT, ());
    }

    // The last window going ends the app by itself; this is only the backstop.
    // It stays out once the windows are gone: an exit asked for then races the
    // one under way, and past the event loop's end `exit` kills the process
    // mid-write.
    std::thread::spawn(move || {
        let deadline = Instant::now() + QUIT_GRACE;

        while !app.webview_windows().is_empty() {
            if Instant::now() >= deadline {
                app.exit(0);
                return;
            }

            std::thread::sleep(Duration::from_millis(50));
        }
    });
}
