//! The window's frame across runs, so a reopened recent file comes back at the
//! size it was read in — one record for the whole app, the last frame the
//! reader interacted with, kept like the rest in app data, never the WebView.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow, Window};

use crate::store::{Store, Stored};

/// A drag or resize reports many events a second; the disk hears of it this
/// often at most, and the exit flush carries whatever the throttle held back.
const WRITE_INTERVAL: Duration = Duration::from_millis(500);

/// Past this a value is damage, not geometry — no window the reader made is a
/// kilometre wide, and `inf` survives a hand edit where it began as a mistake.
const MAX_DIMENSION: f64 = 16384.0;

/// Physical pixels with the scale they were measured at: physical coordinates
/// name the monitor they belong to, and the scale lets a later run on a
/// differently-scaled display put the same logical window back.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowGeometry {
    maximized: bool,
    scale: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl WindowGeometry {
    fn is_valid(&self) -> bool {
        let (logical_width, logical_height) = self.logical_size();

        self.scale.is_finite()
            && self.scale > 0.0
            && [self.x, self.y, self.width, self.height]
                .into_iter()
                .all(|value| value.is_finite())
            && self.width > 0.0
            && self.width <= MAX_DIMENSION
            && self.height > 0.0
            && self.height <= MAX_DIMENSION
            // The same ceiling on the logical size: a hand-edited near-zero
            // scale would otherwise ask for a window millions of pixels wide.
            && logical_width <= MAX_DIMENSION
            && logical_height <= MAX_DIMENSION
    }

    fn logical_size(&self) -> (f64, f64) {
        (self.width / self.scale, self.height / self.scale)
    }
}

#[derive(Default, Serialize)]
struct WindowStateDocument {
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<WindowGeometry>,
}

impl Stored for WindowStateDocument {
    const FILE_NAME: &'static str = "window-state.toml";

    /// Total on purpose: an older schema or a hand edit must not cost the run
    /// its window, only the frame that file described.
    fn parse(contents: &str) -> Self {
        let table = contents.parse::<toml::Table>().unwrap_or_default();

        Self {
            window: table
                .get("window")
                .cloned()
                .and_then(|value| WindowGeometry::deserialize(value).ok())
                .filter(WindowGeometry::is_valid),
        }
    }

    fn render(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}

/// A maximized frame is not one to restore to: it keeps the bounds the window
/// last had unmaximized and remembers only that the reader left it maximized.
fn folded(observed: WindowGeometry, kept: Option<WindowGeometry>) -> Option<WindowGeometry> {
    if observed.maximized {
        kept.map(|kept| WindowGeometry {
            maximized: true,
            ..kept
        })
    } else {
        Some(observed)
    }
}

#[derive(Default)]
struct WindowMemo {
    geometry: Option<WindowGeometry>,
    written: Option<Instant>,
    /// Set while a trailing write sleeps, so a burst arms one timer, not many.
    trailing: bool,
}

#[derive(Clone)]
pub struct WindowState {
    store: Store<WindowStateDocument>,
    memo: Arc<Mutex<WindowMemo>>,
}

impl WindowState {
    pub fn load(app: &AppHandle) -> Self {
        Self::from_store(Store::<WindowStateDocument>::load(app))
    }

    fn from_store(store: Store<WindowStateDocument>) -> Self {
        Self {
            memo: Arc::new(Mutex::new(WindowMemo {
                geometry: store.read(|document| document.window),
                written: None,
                trailing: false,
            })),
            store,
        }
    }

    /// `load` with the file already named, for the tests' scratch stores.
    #[cfg(test)]
    fn at(file: &std::path::Path) -> Self {
        Self::from_store(Store::<WindowStateDocument>::at(Some(file.to_path_buf())))
    }

    fn record(&self, observed: WindowGeometry) {
        let Ok(mut memo) = self.memo.lock() else {
            return;
        };

        let Some(next) = folded(observed, memo.geometry) else {
            return;
        };

        memo.geometry = Some(next);

        // A repeated event, not a change: what the file holds is what came in.
        if self.store.read(|document| document.window == Some(next)) {
            return;
        }

        // The first change always lands; after that, a burst of moves shares
        // one write, and the tail lands when the burst goes quiet.
        if memo
            .written
            .is_none_or(|written| written.elapsed() >= WRITE_INTERVAL)
        {
            self.write(memo, next);
        } else if !memo.trailing {
            memo.trailing = true;
            let state = self.clone();

            std::thread::spawn(move || {
                std::thread::sleep(WRITE_INTERVAL);
                state.write_trailing();
            });
        }
    }

    fn write(&self, mut memo: MutexGuard<'_, WindowMemo>, geometry: WindowGeometry) {
        self.store
            .write(|document| document.window = Some(geometry));
        memo.written = Some(Instant::now());
    }

    /// The write a throttled burst owed, once nothing more has arrived: without
    /// it the last frame of a gesture sits in memory until an exit that a
    /// terminated session, the common way a Linux login ends, never runs.
    fn write_trailing(&self) {
        let Ok(mut memo) = self.memo.lock() else {
            return;
        };

        memo.trailing = false;

        let Some(geometry) = memo.geometry else {
            return;
        };

        if self.store.read(|document| document.window) != Some(geometry) {
            self.write(memo, geometry);
        }
    }

    /// The one write the throttle may still be holding, on the way out.
    fn flush_stale(&self) {
        let latest = match self.memo.lock() {
            Ok(memo) => memo.geometry,
            Err(_) => return,
        };

        if latest
            .is_some_and(|geometry| self.store.read(|document| document.window) != Some(geometry))
        {
            self.store.write(|document| document.window = latest);
        }
    }
}

/// Applies what a previous run left to the main window, the only label a later
/// run has again, and shows it: the config hides `main` until here so the
/// restored frame is the first one seen rather than a default that jumps.
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<WindowState>();

    if let Some(geometry) = state
        .store
        .read(|document| document.window)
        .filter(|geometry| fits_the_desktop(&window, geometry))
    {
        let (width, height) = geometry.logical_size();

        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));

        if geometry.maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
}

/// A stored frame is worth applying only where this desktop can still show it:
/// not below the configured minimum, and not where a monitor unplugged since
/// would leave it off-screen with no way to reach it.
fn fits_the_desktop(window: &WebviewWindow, geometry: &WindowGeometry) -> bool {
    let (width, height) = geometry.logical_size();
    let (min_width, min_height) = window
        .app_handle()
        .config()
        .app
        .windows
        .first()
        .map(|config| {
            (
                config.min_width.unwrap_or(0.0),
                config.min_height.unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0));

    if width < min_width || height < min_height {
        return false;
    }

    let Ok(monitors) = window.available_monitors() else {
        // No monitor list to argue with: the window manager gets the final say.
        return true;
    };

    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let left = position.x as i64;
        let top = position.y as i64;

        (left..left + size.width as i64).contains(&(geometry.x as i64))
            && (top..top + size.height as i64).contains(&(geometry.y as i64))
    })
}

/// What a resize, move, or focus reports: the live frame of the window the
/// reader just touched, which is the frame the next run should come back to.
pub fn remember(app: &AppHandle, window: &Window) {
    let Some(state) = app.try_state::<WindowState>() else {
        return;
    };

    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };

    state.record(WindowGeometry {
        maximized: window.is_maximized().unwrap_or(false),
        scale,
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    });
}

/// The one write the throttle may have held back, on the way out of the process.
pub fn flush(app: &AppHandle) {
    app.state::<WindowState>().flush_stale();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn geometry() -> WindowGeometry {
        WindowGeometry {
            maximized: false,
            scale: 2.0,
            x: -1920.0,
            y: 40.0,
            width: 2560.0,
            height: 1414.0,
        }
    }

    #[test]
    fn round_trips_the_frame_through_the_file() {
        let document = WindowStateDocument {
            window: Some(geometry()),
        };
        let rendered = document.render().expect("the frame should render");
        let parsed = WindowStateDocument::parse(&rendered);

        assert_eq!(parsed.window, Some(geometry()));
    }

    #[test]
    fn an_unreadable_file_reads_as_empty() {
        assert!(WindowStateDocument::parse("{ not toml").window.is_none());
        assert!(WindowStateDocument::parse("").window.is_none());
        assert!(
            WindowStateDocument::parse(r#"window = "from another version""#)
                .window
                .is_none()
        );
    }

    #[test]
    fn rejects_a_frame_this_app_could_not_have_recorded() {
        let damages = [
            (
                "a zero width",
                WindowGeometry {
                    width: 0.0,
                    ..geometry()
                },
            ),
            (
                "a negative height",
                WindowGeometry {
                    height: -100.0,
                    ..geometry()
                },
            ),
            (
                "a zero scale",
                WindowGeometry {
                    scale: 0.0,
                    ..geometry()
                },
            ),
            (
                "a near-zero scale that inflates the logical size",
                WindowGeometry {
                    scale: 0.001,
                    ..geometry()
                },
            ),
            (
                "an infinite scale",
                WindowGeometry {
                    scale: f64::INFINITY,
                    ..geometry()
                },
            ),
            (
                "a NaN position",
                WindowGeometry {
                    x: f64::NAN,
                    ..geometry()
                },
            ),
            (
                "an oversized width",
                WindowGeometry {
                    width: MAX_DIMENSION * 2.0,
                    ..geometry()
                },
            ),
        ];

        for (name, damaged) in damages {
            let rendered = WindowStateDocument {
                window: Some(damaged),
            }
            .render()
            .expect("TOML writes inf and nan, so damage survives to be read");

            assert!(
                WindowStateDocument::parse(&rendered).window.is_none(),
                "{name} should not come back as a frame"
            );
        }
    }

    #[test]
    fn a_maximized_frame_keeps_the_bounds_it_last_had_unmaximized() {
        let unmaximized = geometry();
        let maximized = WindowGeometry {
            maximized: true,
            width: 3840.0,
            height: 2160.0,
            ..geometry()
        };

        assert_eq!(
            folded(maximized, Some(unmaximized)),
            Some(WindowGeometry {
                maximized: true,
                ..unmaximized
            })
        );
        // A window maximized from birth has no smaller frame to remember.
        assert_eq!(folded(maximized, None), None);
        assert_eq!(folded(unmaximized, None), Some(unmaximized));
    }

    #[test]
    fn a_larger_scale_shrinks_the_logical_size_back() {
        assert_eq!(geometry().logical_size(), (1280.0, 707.0));
    }

    fn scratch(name: &str) -> (WindowState, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("tfolio-window-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let file = directory.join(WindowStateDocument::FILE_NAME);

        (WindowState::at(&file), file)
    }

    fn on_disk(file: &Path) -> Option<WindowGeometry> {
        WindowStateDocument::parse(&std::fs::read_to_string(file).unwrap_or_default()).window
    }

    #[test]
    fn the_first_change_lands_immediately_and_a_repeat_lands_nothing() {
        let (state, file) = scratch("first-change");

        state.record(geometry());
        assert_eq!(on_disk(&file), Some(geometry()));

        state.record(geometry());
        assert_eq!(on_disk(&file), Some(geometry()));

        let _ = std::fs::remove_dir_all(file.parent().expect("the scratch file has a directory"));
    }

    #[test]
    fn a_throttled_burst_defers_to_the_trailing_write() {
        let (state, file) = scratch("throttled-burst");
        let moved = WindowGeometry {
            x: 200.0,
            ..geometry()
        };

        state.record(geometry());
        // Within the interval of the first write, so the disk keeps the older
        // frame until what the armed timer does runs.
        state.record(moved);
        assert_eq!(on_disk(&file), Some(geometry()));

        state.write_trailing();
        assert_eq!(on_disk(&file), Some(moved));

        let _ = std::fs::remove_dir_all(file.parent().expect("the scratch file has a directory"));
    }

    #[test]
    fn flush_writes_only_what_the_throttle_is_still_holding() {
        let (state, file) = scratch("exit-flush");

        state.flush_stale();
        assert_eq!(on_disk(&file), None);

        state.record(geometry());
        state.flush_stale();
        assert_eq!(on_disk(&file), Some(geometry()));

        let resized = WindowGeometry {
            height: 1000.0,
            ..geometry()
        };
        state.record(resized);
        state.flush_stale();
        assert_eq!(on_disk(&file), Some(resized));

        let _ = std::fs::remove_dir_all(file.parent().expect("the scratch file has a directory"));
    }
}
