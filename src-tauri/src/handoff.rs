//! A tab dragged to another window is an ownership change plus a payload the
//! destination takes when its page is ready — the same wait a launch file has,
//! for the same reason: an event fired before a window listens reaches nobody.

use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde::Deserialize;
use serde_json::Value;
use tauri::{
    utils::config::WindowConfig, AppHandle, Emitter, Manager, State, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::windows::{page_generation, record_document, window_config_from, DocumentOwners};

/// Carries nothing but that a take will find something; spelled again in
/// `App.tsx`, which listens for it.
pub const TAB_ARRIVED_EVENT: &str = "workspace://tab-arrived";

/// The page state of a moved tab. Rust carries it without reading it: the
/// `path` beside it is the owners table's own record, never the page's say.
pub struct HandoffEntry {
    pub document_id: u64,
    pub from: String,
    pub path: Option<PathBuf>,
    pub tab: Value,
}

#[derive(Default)]
pub struct HandoffQueue(Mutex<HashMap<String, Vec<HandoffEntry>>>);

impl HandoffQueue {
    fn push(&self, label: &str, entry: HandoffEntry) {
        if let Ok(mut queued) = self.0.lock() {
            queued.entry(label.to_string()).or_default().push(entry);
        }
    }

    /// Drains a window's queue. The take after a boot or reload empties it;
    /// the gone-window path drains it to hand each entry back or close it.
    pub fn take(&self, label: &str) -> Vec<HandoffEntry> {
        self.0
            .lock()
            .ok()
            .and_then(|mut queued| queued.remove(label))
            .unwrap_or_default()
    }

    /// Documents a `release_window` must leave standing: their window is only
    /// reloading, and the take after that completes what the move began.
    pub fn pending_ids(&self, label: &str) -> Vec<u64> {
        self.0
            .lock()
            .map(|queued| {
                queued
                    .get(label)
                    .map(|entries| entries.iter().map(|entry| entry.document_id).collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }
}

/// Where a torn-off tab was let go, in physical pixels.
#[derive(Deserialize)]
pub struct DropPoint {
    x: f64,
    y: f64,
}

/// Moves a tab to a window that already exists. The take on the other side is
/// what shows it; this only changes who holds the document and queues the rest.
#[tauri::command]
pub async fn move_document(
    document_id: u64,
    dest_label: String,
    tab: Value,
    app: AppHandle,
    owners: State<'_, DocumentOwners>,
    handoff: State<'_, HandoffQueue>,
    window: WebviewWindow,
) -> Result<(), String> {
    let from = window.label().to_string();

    if dest_label == from {
        return Err("a tab cannot move to the window it is in".to_string());
    }

    if app.get_webview_window(&dest_label).is_none() {
        return Err("the destination window is gone".to_string());
    }

    let Some(path) = owners.transfer(document_id, &from, &dest_label) else {
        return Err("this window does not hold that document".to_string());
    };

    handoff.push(
        &dest_label,
        HandoffEntry {
            document_id,
            from,
            path,
            tab,
        },
    );

    // The destination may have gone between the check above and the push,
    // its drain already run: this sender, still here, takes the tab back.
    if app.get_webview_window(&dest_label).is_none() {
        return_pending(&app, &dest_label);
        return Err("the destination window is gone".to_string());
    }

    let _ = app.emit_to(dest_label.as_str(), TAB_ARRIVED_EVENT, ());

    Ok(())
}

/// Tears a tab off into a window of its own, placed where it was let go. The
/// new page announces nothing: like a launch, its take happens while booting.
#[tauri::command]
pub async fn move_document_new_window(
    document_id: u64,
    tab: Value,
    at: Option<DropPoint>,
    app: AppHandle,
    owners: State<'_, DocumentOwners>,
    handoff: State<'_, HandoffQueue>,
    window: WebviewWindow,
) -> Result<String, String> {
    let from = window.label().to_string();

    if !owners.owns(document_id, &from) {
        return Err("this window does not hold that document".to_string());
    }

    let mut config = window_config_from(&app, &window)?;

    match at {
        // A torn-off tab opens where the reader let it go, kept whole on the
        // monitor under that point; a monitor the point names none of falls
        // back to the asking window's cascade.
        Some(at) if position_at(&app, &mut config, at.x, at.y) => {}
        _ => crate::windows::cascade_from(&window, &mut config),
    }

    let new_window = WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map_err(|error| format!("a new window could not be opened: {error}"))?;
    let label = new_window.label().to_string();

    let Some(path) = owners.transfer(document_id, &from, &label) else {
        // Nothing moved, so the window just built has nothing to wait for:
        // take it back down rather than leave an empty frame on screen.
        let _ = new_window.destroy();
        return Err("this window does not hold that document".to_string());
    };

    handoff.push(
        &label,
        HandoffEntry {
            document_id,
            from,
            path,
            tab,
        },
    );

    // As for an existing destination: a window closed before the push had
    // nothing to hand back yet.
    if app.get_webview_window(&label).is_none() {
        return_pending(&app, &label);
        return Err("the new window is gone".to_string());
    }

    Ok(label)
}

/// Where a window's own edge sits along an axis, keeping the whole window on
/// the monitor's work area. A window larger than the area has no span to move
/// within, so the origin is as far as it goes — a plain `clamp` would be given
/// an inverted range there and panic.
fn clamped_edge(value: f64, origin: f64, area_size: f64, window_size: f64) -> f64 {
    let last = (origin + area_size - window_size).max(origin);

    value.clamp(origin, last)
}

/// Sets a window config's position from a physical point on screen. Returns
/// whether it could: a `false` leaves the config for the caller's fallback.
fn position_at(app: &AppHandle, config: &mut WindowConfig, x: f64, y: f64) -> bool {
    let Ok(Some(monitor)) = app.monitor_from_point(x, y) else {
        return false;
    };

    // Logical, as the config speaks it; the clamp answers in one scale because
    // the monitor under the point is the one the window opens on.
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (area_x, area_y) = (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
    );
    let (area_width, area_height) = (
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    );

    config.center = false;
    config.x = Some(clamped_edge(x / scale, area_x, area_width, config.width));
    config.y = Some(clamped_edge(y / scale, area_y, area_height, config.height));

    true
}

/// Drains what other windows sent here. Re-recording is idempotent — the move
/// already wrote it — and makes good a reload that stood between the two;
/// `record_document` because a window destroyed mid-take must not leave
/// records standing for documents it just closed.
#[tauri::command]
pub async fn take_moved_tabs(
    owners: State<'_, DocumentOwners>,
    handoff: State<'_, HandoffQueue>,
    window: WebviewWindow,
) -> Result<Vec<Value>, String> {
    let label = window.label().to_string();
    let page = page_generation(&window);

    Ok(handoff
        .take(&label)
        .into_iter()
        .map(|entry| {
            record_document(&owners, &window, page, entry.document_id, entry.path);
            entry.tab
        })
        .collect())
}

/// A destination that died before taking what it was sent gives it back: the
/// window a tab came from can take it again, and only a sender gone too leaves
/// the document to close with the move that failed.
pub fn return_pending(app: &AppHandle, label: &str) {
    let (Some(handoff), Some(owners), Some(pdfium)) = (
        app.try_state::<HandoffQueue>(),
        app.try_state::<DocumentOwners>(),
        app.try_state::<crate::pdfium::PdfiumState>(),
    ) else {
        return;
    };

    for entry in handoff.take(label) {
        let from = entry.from.clone();

        if app.get_webview_window(&from).is_some()
            && owners.transfer(entry.document_id, label, &from).is_some()
        {
            handoff.push(&from, entry);
            let _ = app.emit_to(from.as_str(), TAB_ARRIVED_EVENT, ());
        } else {
            pdfium.close_document_detached(entry.document_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64, from: &str) -> HandoffEntry {
        HandoffEntry {
            document_id: id,
            from: from.to_string(),
            path: None,
            tab: Value::Null,
        }
    }

    #[test]
    fn hands_each_window_only_what_was_queued_for_it() {
        let queue = HandoffQueue::default();
        queue.push("window-2", entry(1, "main"));
        queue.push("window-3", entry(2, "main"));

        let taken = queue.take("window-2");
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].document_id, 1);
        assert!(queue.take("window-2").is_empty());
        assert_eq!(queue.pending_ids("window-3"), vec![2]);
    }

    #[test]
    fn a_pending_handoff_survives_the_drain_that_never_took_it() {
        let queue = HandoffQueue::default();
        queue.push("window-2", entry(1, "main"));
        queue.push("window-2", entry(2, "main"));

        assert_eq!(queue.pending_ids("window-2"), vec![1, 2]);

        // A reload releases nothing here; the drain is what empties the queue —
        // the gone-window path's drain no less than a take's.
        let returned = queue.take("window-2");
        assert_eq!(returned.len(), 2);
        assert!(queue.pending_ids("window-2").is_empty());
    }

    #[test]
    fn a_window_with_nothing_queued_answers_empty() {
        let queue = HandoffQueue::default();

        assert!(queue.pending_ids("main").is_empty());
        assert!(queue.take("main").is_empty());
    }

    #[test]
    fn a_window_larger_than_the_area_still_gets_a_place() {
        // A drop from a window wider than the monitor it landed on must not
        // turn the clamp's range inside out.
        assert_eq!(clamped_edge(500.0, 0.0, 1366.0, 1920.0), 0.0);
        assert_eq!(clamped_edge(-20.0, 100.0, 600.0, 1920.0), 100.0);
    }

    #[test]
    fn a_window_that_fits_keeps_the_drop_point_inside_the_area() {
        assert_eq!(clamped_edge(500.0, 0.0, 1366.0, 800.0), 500.0);
        assert_eq!(clamped_edge(1300.0, 0.0, 1366.0, 800.0), 566.0);
        assert_eq!(clamped_edge(-40.0, 100.0, 1366.0, 800.0), 100.0);
        assert_eq!(clamped_edge(2000.0, 100.0, 1366.0, 800.0), 666.0);
    }
}
