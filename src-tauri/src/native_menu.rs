//! Native macOS top menu bar, native context menu popups, and pasteboard writes.

use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicU64, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "macos")]
use tauri::{
    menu::{
        AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    Emitter, Manager, Wry,
};

#[cfg(target_os = "macos")]
use crate::{quit, windows};

/// Emitted to the focused window when a macOS top menu item is activated.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MENU_ACTION_EVENT: &str = "menu://action";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const HELP_URL: &str = "https://roy-tian.github.io/TFolio/";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const HELP_WEBSITE_ID: &str = "help-website";
const MAX_RECENT_MENU_ITEMS: usize = 10;
const MAX_CONTEXT_MENU_ITEMS: usize = 64;
const CONTEXT_PREFIX: &str = "ctx:";
const RECENT_PREFIX: &str = "recent:";

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacMenuStaticLabels {
    pub app_name: String,
    pub file: String,
    pub edit: String,
    pub tools: String,
    pub view: String,
    pub window: String,
    pub help: String,
    pub about_app: String,
    pub check_updates: String,
    pub settings: String,
    pub services: String,
    pub hide_app: String,
    pub hide_others: String,
    pub show_all: String,
    pub quit_app: String,
    pub new_doc: String,
    pub new_window: String,
    pub open: String,
    pub open_recent: String,
    pub recent_empty: String,
    pub add_files: String,
    pub save: String,
    pub save_all: String,
    pub save_as: String,
    pub fit_a4: String,
    pub export_images: String,
    pub split: String,
    pub compress: String,
    pub close_tab: String,
    pub close_all: String,
    pub close_window: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub find: String,
    pub highlight: String,
    pub rect: String,
    pub text_note: String,
    pub eraser: String,
    pub watermark: String,
    pub page_numbers: String,
    pub single_page: String,
    pub book: String,
    pub zoom_in: String,
    pub zoom_out: String,
    pub zoom_reset: String,
    pub zoom_fit_width: String,
    pub zoom_fit_page: String,
    pub enter_full_screen: String,
    pub minimize: String,
    pub maximize: String,
    pub app_help: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacMenuDynamicLabels {
    pub undo: String,
    pub redo: String,
    pub toggle_sidebar: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentMenuEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacMenuFlags {
    pub has_document: bool,
    pub can_save: bool,
    pub save_as_only: bool,
    pub can_save_all: bool,
    pub can_close_all: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub typing_target: bool,
    pub active_tool: Option<String>,
    pub view_mode: Option<String>,
    pub book_applies: bool,
    pub zoom_can_in: bool,
    pub zoom_can_out: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacMenuSnapshot {
    pub static_labels: MacMenuStaticLabels,
    pub dynamic_labels: MacMenuDynamicLabels,
    pub flags: MacMenuFlags,
    pub recent_files: Vec<RecentMenuEntry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NativeContextMenuItem {
    Item {
        id: String,
        label: String,
        #[serde(default = "default_true")]
        enabled: bool,
        /// A choice among several (a dropdown's current one): `None` is a
        /// plain item, never a checkable one.
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator,
}

/// Where a popup's top-left corner goes, in logical pixels from the window's
/// top-left: under a dropdown's trigger rather than at the pointer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct NativeMenuPoint {
    pub x: f64,
    pub y: f64,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuActionPayload {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn format_context_item_id(seq: u64, action_id: &str) -> String {
    format!("{CONTEXT_PREFIX}{seq}:{action_id}")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_context_item_id(id: &str) -> Option<(u64, String)> {
    let rest = id.strip_prefix(CONTEXT_PREFIX)?;
    let (seq_str, action_id) = rest.split_once(':')?;
    let seq = seq_str.parse::<u64>().ok()?;
    if action_id.is_empty() {
        return None;
    }
    Some((seq, action_id.to_string()))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn format_recent_item_id(generation: u64, index: usize) -> String {
    format!("{RECENT_PREFIX}{generation}:{index}")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_recent_item_id(id: &str) -> Option<(u64, usize)> {
    let rest = id.strip_prefix(RECENT_PREFIX)?;
    let (generation_str, index_str) = rest.split_once(':')?;
    let generation = generation_str.parse::<u64>().ok()?;
    let index = index_str.parse::<usize>().ok()?;
    Some((generation, index))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Default)]
struct RecentMenuRegistry {
    active_generation: u64,
    paths: Vec<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl RecentMenuRegistry {
    fn replace(&mut self, paths: Vec<String>) -> u64 {
        self.active_generation += 1;
        self.paths = paths;
        self.active_generation
    }

    fn resolve(&self, generation: u64, index: usize) -> Option<&str> {
        (generation == self.active_generation)
            .then(|| self.paths.get(index).map(String::as_str))
            .flatten()
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn removes_accelerator(prev: Option<&str>, next: Option<&str>) -> bool {
    prev.is_some() && next.is_none()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn needs_menu_rebuild(
    prev_labels: &MacMenuStaticLabels,
    prev_flags: &MacMenuFlags,
    next_labels: &MacMenuStaticLabels,
    next_flags: &MacMenuFlags,
) -> bool {
    if prev_labels != next_labels {
        return true;
    }

    let prev_close = close_accelerators(prev_flags.has_document);
    let next_close = close_accelerators(next_flags.has_document);
    let prev_save = save_accelerators(prev_flags.has_document, prev_flags.save_as_only);
    let next_save = save_accelerators(next_flags.has_document, next_flags.save_as_only);

    removes_accelerator(prev_close.0, next_close.0)
        || removes_accelerator(prev_close.1, next_close.1)
        || removes_accelerator(prev_save.0, next_save.0)
        || removes_accelerator(prev_save.1, next_save.1)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_checkable_menu_id(id: &str) -> bool {
    matches!(
        id,
        "tool-highlight"
            | "tool-rect"
            | "tool-text-note"
            | "tool-eraser"
            | "view-single"
            | "view-book"
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn should_accept_snapshot<T: Ord>(current: Option<T>, incoming: T) -> bool {
    current.is_none_or(|latest| incoming > latest)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clamp_recent_entries(entries: &[RecentMenuEntry]) -> Vec<RecentMenuEntry> {
    entries
        .iter()
        .take(MAX_RECENT_MENU_ITEMS)
        .cloned()
        .collect()
}

/// muda reads `&` as a mnemonic marker and drops it; labels carry file names.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn escape_mnemonic(label: &str) -> String {
    label.replace('&', "&&")
}

fn validate_menu_point(point: Option<NativeMenuPoint>) -> Result<(), String> {
    match point {
        Some(NativeMenuPoint { x, y })
            if !x.is_finite() || !y.is_finite() || x.abs() > 1e6 || y.abs() > 1e6 =>
        {
            Err("context menu position is out of range".into())
        }
        _ => Ok(()),
    }
}

fn validate_context_items(items: &[NativeContextMenuItem]) -> Result<(), String> {
    if items.len() > MAX_CONTEXT_MENU_ITEMS {
        return Err(format!(
            "context menu exceeds {MAX_CONTEXT_MENU_ITEMS} items"
        ));
    }

    for item in items {
        if let NativeContextMenuItem::Item { id, .. } = item {
            if id.is_empty() {
                return Err("context menu item id must not be empty".into());
            }
        }
    }

    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn save_accelerators(
    has_document: bool,
    save_as_only: bool,
) -> (Option<&'static str>, Option<&'static str>) {
    if has_document && save_as_only {
        (None, Some("CmdOrCtrl+S"))
    } else {
        (Some("CmdOrCtrl+S"), Some("CmdOrCtrl+Shift+S"))
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn close_accelerators(has_document: bool) -> (Option<&'static str>, Option<&'static str>) {
    if has_document {
        (Some("CmdOrCtrl+W"), Some("CmdOrCtrl+Shift+W"))
    } else {
        (None, Some("CmdOrCtrl+W"))
    }
}

#[cfg(target_os = "macos")]
struct InstalledMacMenu {
    static_labels: MacMenuStaticLabels,
    dynamic_labels: MacMenuDynamicLabels,
    flags: MacMenuFlags,
    recent_entries: Vec<RecentMenuEntry>,
    open_recent: Submenu<Wry>,
    add_files: MenuItem<Wry>,
    save: MenuItem<Wry>,
    save_all: MenuItem<Wry>,
    save_as: MenuItem<Wry>,
    fit_a4: MenuItem<Wry>,
    export_images: MenuItem<Wry>,
    split: MenuItem<Wry>,
    compress: MenuItem<Wry>,
    close_tab: MenuItem<Wry>,
    close_all: MenuItem<Wry>,
    close_window: MenuItem<Wry>,
    undo: MenuItem<Wry>,
    redo: MenuItem<Wry>,
    select_all: MenuItem<Wry>,
    find: MenuItem<Wry>,
    highlight: CheckMenuItem<Wry>,
    rect: CheckMenuItem<Wry>,
    text_note: CheckMenuItem<Wry>,
    eraser: CheckMenuItem<Wry>,
    watermark: MenuItem<Wry>,
    page_numbers: MenuItem<Wry>,
    toggle_sidebar: MenuItem<Wry>,
    single_page: CheckMenuItem<Wry>,
    book: CheckMenuItem<Wry>,
    zoom_in: MenuItem<Wry>,
    zoom_out: MenuItem<Wry>,
    zoom_reset: MenuItem<Wry>,
    zoom_fit_width: MenuItem<Wry>,
    zoom_fit_page: MenuItem<Wry>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct StoredWindowSnapshot {
    page: windows::PageGeneration,
    seq: u64,
    snapshot: MacMenuSnapshot,
}

#[derive(Default)]
pub struct NativeMenuState {
    #[cfg(target_os = "macos")]
    snapshots: Mutex<HashMap<String, StoredWindowSnapshot>>,
    #[cfg(target_os = "macos")]
    recent_registry: Mutex<RecentMenuRegistry>,
    #[cfg(target_os = "macos")]
    installed: Mutex<Option<InstalledMacMenu>>,
    #[cfg(target_os = "macos")]
    apply_lock: Mutex<()>,
    #[cfg(target_os = "macos")]
    last_popup: Mutex<Option<Menu<Wry>>>,
    #[cfg(target_os = "macos")]
    popup_lock: tauri::async_runtime::Mutex<()>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    context_seq: AtomicU64,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    context_results: Mutex<HashMap<u64, String>>,
}

/// Minimal fallback menu installed at startup before JS syncs the localized menu.
/// The Edit items stay predefined — without them Cmd+C and Cmd+V stop working
/// in every text field.
#[cfg(target_os = "macos")]
pub fn initial_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|name| vec![name]),
        ..Default::default()
    };
    let quit_item = MenuItem::with_id(
        app,
        quit::QUIT_MENU_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                package.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            // By Tauri's ids, which make AppKit list open windows and the
            // help search in them.
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn replace_recent_registry(state: &NativeMenuState, entries: &[RecentMenuEntry]) -> u64 {
    let paths = entries.iter().map(|entry| entry.path.clone()).collect();
    state
        .recent_registry
        .lock()
        .map(|mut registry| registry.replace(paths))
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn populate_recent_submenu(
    app: &AppHandle,
    submenu: &Submenu<Wry>,
    empty_label: &str,
    generation: u64,
    entries: &[RecentMenuEntry],
) -> tauri::Result<()> {
    while submenu.remove_at(0)?.is_some() {}

    if entries.is_empty() {
        let empty = MenuItem::with_id(app, "recent-empty", empty_label, false, None::<&str>)?;
        submenu.append(&empty)?;
        return Ok(());
    }

    for (index, entry) in entries.iter().enumerate() {
        let item = MenuItem::with_id(
            app,
            format_recent_item_id(generation, index),
            escape_mnemonic(&entry.name),
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn build_installed_menu(
    app: &AppHandle,
    state: &NativeMenuState,
    snapshot: &MacMenuSnapshot,
) -> tauri::Result<(Menu<Wry>, InstalledMacMenu)> {
    let s = &snapshot.static_labels;
    let d = &snapshot.dynamic_labels;
    let f = &snapshot.flags;
    let recent_entries = clamp_recent_entries(&snapshot.recent_files);
    let recent_generation = replace_recent_registry(state, &recent_entries);
    let (save_accel, save_as_accel) = save_accelerators(f.has_document, f.save_as_only);
    let (close_tab_accel, close_window_accel) = close_accelerators(f.has_document);

    // App menu
    let about_item = MenuItem::with_id(app, "app-about", &s.about_app, true, None::<&str>)?;
    let check_updates_item = MenuItem::with_id(
        app,
        "app-check-updates",
        &s.check_updates,
        true,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(
        app,
        "app-settings",
        &s.settings,
        true,
        Some("CmdOrCtrl+Comma"),
    )?;
    let quit_item = MenuItem::with_id(
        app,
        quit::QUIT_MENU_ID,
        &s.quit_app,
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    let app_submenu = Submenu::with_items(
        app,
        &s.app_name,
        true,
        &[
            &about_item,
            &check_updates_item,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&s.services))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&s.hide_app))?,
            &PredefinedMenuItem::hide_others(app, Some(&s.hide_others))?,
            &PredefinedMenuItem::show_all(app, Some(&s.show_all))?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    // File menu
    let new_item = MenuItem::with_id(app, "file-new", &s.new_doc, true, Some("CmdOrCtrl+N"))?;
    let new_window_item = MenuItem::with_id(
        app,
        "file-new-window",
        &s.new_window,
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_item = MenuItem::with_id(app, "file-open", &s.open, true, Some("CmdOrCtrl+O"))?;
    let open_recent = Submenu::new(app, &s.open_recent, true)?;
    populate_recent_submenu(
        app,
        &open_recent,
        &s.recent_empty,
        recent_generation,
        &recent_entries,
    )?;

    let add_files = MenuItem::with_id(
        app,
        "file-add-files",
        &s.add_files,
        f.has_document,
        None::<&str>,
    )?;
    let save = MenuItem::with_id(
        app,
        "file-save",
        &s.save,
        f.has_document && f.can_save,
        save_accel,
    )?;
    let save_all = MenuItem::with_id(
        app,
        "file-save-all",
        &s.save_all,
        f.can_save_all,
        Some("CmdOrCtrl+Alt+S"),
    )?;
    let save_as = MenuItem::with_id(
        app,
        "file-save-as",
        &s.save_as,
        f.has_document,
        save_as_accel,
    )?;
    let fit_a4 = MenuItem::with_id(app, "file-fit-a4", &s.fit_a4, f.has_document, None::<&str>)?;
    let export_images = MenuItem::with_id(
        app,
        "file-export-images",
        &s.export_images,
        f.has_document,
        None::<&str>,
    )?;
    let split = MenuItem::with_id(app, "file-split", &s.split, f.has_document, None::<&str>)?;
    let compress = MenuItem::with_id(
        app,
        "file-compress",
        &s.compress,
        f.has_document,
        None::<&str>,
    )?;
    let close_tab = MenuItem::with_id(
        app,
        "file-close-tab",
        &s.close_tab,
        f.has_document,
        close_tab_accel,
    )?;
    let close_all = MenuItem::with_id(
        app,
        "file-close-all",
        &s.close_all,
        f.can_close_all,
        None::<&str>,
    )?;
    let close_window = MenuItem::with_id(
        app,
        "file-close-window",
        &s.close_window,
        true,
        close_window_accel,
    )?;

    let file_submenu = Submenu::with_items(
        app,
        &s.file,
        true,
        &[
            &new_item,
            &new_window_item,
            &open_item,
            &open_recent,
            &PredefinedMenuItem::separator(app)?,
            &add_files,
            &PredefinedMenuItem::separator(app)?,
            &save,
            &save_all,
            &save_as,
            &PredefinedMenuItem::separator(app)?,
            &fit_a4,
            &export_images,
            &split,
            &compress,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
            &close_all,
            &close_window,
        ],
    )?;

    // Edit menu
    let undo = MenuItem::with_id(
        app,
        "edit-undo",
        &d.undo,
        f.typing_target || (f.has_document && f.can_undo),
        Some("CmdOrCtrl+Z"),
    )?;
    let redo = MenuItem::with_id(
        app,
        "edit-redo",
        &d.redo,
        f.typing_target || (f.has_document && f.can_redo),
        Some("CmdOrCtrl+Shift+Z"),
    )?;
    let select_all = MenuItem::with_id(
        app,
        "edit-select-all",
        &s.select_all,
        f.typing_target || f.has_document,
        Some("CmdOrCtrl+A"),
    )?;
    let find = MenuItem::with_id(
        app,
        "edit-find",
        &s.find,
        f.has_document,
        Some("CmdOrCtrl+F"),
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        &s.edit,
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&s.cut))?,
            &PredefinedMenuItem::copy(app, Some(&s.copy))?,
            &PredefinedMenuItem::paste(app, Some(&s.paste))?,
            &select_all,
            &PredefinedMenuItem::separator(app)?,
            &find,
        ],
    )?;

    // Tools menu
    let active_tool = f.active_tool.as_deref();
    let highlight = CheckMenuItem::with_id(
        app,
        "tool-highlight",
        &s.highlight,
        f.has_document,
        f.has_document && active_tool == Some("highlight"),
        None::<&str>,
    )?;
    let rect = CheckMenuItem::with_id(
        app,
        "tool-rect",
        &s.rect,
        f.has_document,
        f.has_document && active_tool == Some("rect"),
        None::<&str>,
    )?;
    let text_note = CheckMenuItem::with_id(
        app,
        "tool-text-note",
        &s.text_note,
        f.has_document,
        f.has_document && active_tool == Some("textNote"),
        None::<&str>,
    )?;
    let eraser = CheckMenuItem::with_id(
        app,
        "tool-eraser",
        &s.eraser,
        f.has_document,
        f.has_document && active_tool == Some("eraser"),
        None::<&str>,
    )?;
    let watermark = MenuItem::with_id(
        app,
        "tool-watermark",
        &s.watermark,
        f.has_document,
        Some("CmdOrCtrl+Alt+W"),
    )?;
    let page_numbers = MenuItem::with_id(
        app,
        "tool-page-numbers",
        &s.page_numbers,
        f.has_document,
        Some("CmdOrCtrl+Alt+P"),
    )?;

    let tools_submenu = Submenu::with_items(
        app,
        &s.tools,
        true,
        &[
            &highlight,
            &rect,
            &text_note,
            &eraser,
            &PredefinedMenuItem::separator(app)?,
            &watermark,
            &page_numbers,
        ],
    )?;

    // View menu
    let toggle_sidebar = MenuItem::with_id(
        app,
        "view-toggle-sidebar",
        &d.toggle_sidebar,
        true,
        None::<&str>,
    )?;
    let view_mode = f.view_mode.as_deref();
    let single_page = CheckMenuItem::with_id(
        app,
        "view-single",
        &s.single_page,
        f.has_document,
        f.has_document && view_mode == Some("single"),
        None::<&str>,
    )?;
    let book = CheckMenuItem::with_id(
        app,
        "view-book",
        &s.book,
        f.has_document && f.book_applies,
        f.has_document && view_mode == Some("book"),
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        "view-zoom-in",
        &s.zoom_in,
        f.has_document && f.zoom_can_in,
        Some("CmdOrCtrl+Equal"),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        "view-zoom-out",
        &s.zoom_out,
        f.has_document && f.zoom_can_out,
        Some("CmdOrCtrl+Minus"),
    )?;
    let zoom_reset = MenuItem::with_id(
        app,
        "view-zoom-reset",
        &s.zoom_reset,
        f.has_document,
        Some("CmdOrCtrl+0"),
    )?;
    let zoom_fit_width = MenuItem::with_id(
        app,
        "view-zoom-fit-width",
        &s.zoom_fit_width,
        f.has_document,
        None::<&str>,
    )?;
    let zoom_fit_page = MenuItem::with_id(
        app,
        "view-zoom-fit-page",
        &s.zoom_fit_page,
        f.has_document,
        None::<&str>,
    )?;

    let view_submenu = Submenu::with_items(
        app,
        &s.view,
        true,
        &[
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &single_page,
            &book,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
            &zoom_fit_width,
            &zoom_fit_page,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some(&s.enter_full_screen))?,
        ],
    )?;

    // Window menu: omit PredefinedMenuItem::close_window because its fixed
    // Cmd+W shortcut conflicts with File -> Close tab.
    let window_submenu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        &s.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&s.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(&s.maximize))?,
        ],
    )?;

    // Help menu
    let help_item = MenuItem::with_id(app, HELP_WEBSITE_ID, &s.app_help, true, None::<&str>)?;
    let help_submenu =
        Submenu::with_id_and_items(app, HELP_SUBMENU_ID, &s.help, true, &[&help_item])?;

    let menu = Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &tools_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )?;

    let installed = InstalledMacMenu {
        static_labels: snapshot.static_labels.clone(),
        dynamic_labels: snapshot.dynamic_labels.clone(),
        flags: snapshot.flags.clone(),
        recent_entries,
        open_recent,
        add_files,
        save,
        save_all,
        save_as,
        fit_a4,
        export_images,
        split,
        compress,
        close_tab,
        close_all,
        close_window,
        undo,
        redo,
        select_all,
        find,
        highlight,
        rect,
        text_note,
        eraser,
        watermark,
        page_numbers,
        toggle_sidebar,
        single_page,
        book,
        zoom_in,
        zoom_out,
        zoom_reset,
        zoom_fit_width,
        zoom_fit_page,
    };

    Ok((menu, installed))
}

#[cfg(target_os = "macos")]
fn sync_tool_checkmarks(installed: &InstalledMacMenu, flags: &MacMenuFlags) -> tauri::Result<()> {
    let active_tool = flags.active_tool.as_deref();
    installed
        .highlight
        .set_checked(flags.has_document && active_tool == Some("highlight"))?;
    installed
        .rect
        .set_checked(flags.has_document && active_tool == Some("rect"))?;
    installed
        .text_note
        .set_checked(flags.has_document && active_tool == Some("textNote"))?;
    installed
        .eraser
        .set_checked(flags.has_document && active_tool == Some("eraser"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_view_mode_checkmarks(
    installed: &InstalledMacMenu,
    flags: &MacMenuFlags,
) -> tauri::Result<()> {
    let view_mode = flags.view_mode.as_deref();
    installed
        .single_page
        .set_checked(flags.has_document && view_mode == Some("single"))?;
    installed
        .book
        .set_checked(flags.has_document && view_mode == Some("book"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn update_installed_menu(
    app: &AppHandle,
    state: &NativeMenuState,
    installed: &mut InstalledMacMenu,
    snapshot: &MacMenuSnapshot,
) -> tauri::Result<()> {
    let f = &snapshot.flags;
    let prev = &installed.flags;
    let d = &snapshot.dynamic_labels;
    let prev_d = &installed.dynamic_labels;

    if d.undo != prev_d.undo {
        installed.undo.set_text(&d.undo)?;
    }
    if d.redo != prev_d.redo {
        installed.redo.set_text(&d.redo)?;
    }
    if d.toggle_sidebar != prev_d.toggle_sidebar {
        installed.toggle_sidebar.set_text(&d.toggle_sidebar)?;
    }

    if f.has_document != prev.has_document {
        installed.add_files.set_enabled(f.has_document)?;
        installed.save_as.set_enabled(f.has_document)?;
        installed.fit_a4.set_enabled(f.has_document)?;
        installed.export_images.set_enabled(f.has_document)?;
        installed.split.set_enabled(f.has_document)?;
        installed.compress.set_enabled(f.has_document)?;
        installed.close_tab.set_enabled(f.has_document)?;
        installed.find.set_enabled(f.has_document)?;
        installed.highlight.set_enabled(f.has_document)?;
        installed.rect.set_enabled(f.has_document)?;
        installed.text_note.set_enabled(f.has_document)?;
        installed.eraser.set_enabled(f.has_document)?;
        installed.watermark.set_enabled(f.has_document)?;
        installed.page_numbers.set_enabled(f.has_document)?;
        installed.single_page.set_enabled(f.has_document)?;
        installed.zoom_reset.set_enabled(f.has_document)?;
        installed.zoom_fit_width.set_enabled(f.has_document)?;
        installed.zoom_fit_page.set_enabled(f.has_document)?;

        let (close_tab_accel, close_window_accel) = close_accelerators(f.has_document);
        installed.close_tab.set_accelerator(close_tab_accel)?;
        installed.close_window.set_accelerator(close_window_accel)?;
    }

    let save_enabled = f.has_document && f.can_save;
    if save_enabled != (prev.has_document && prev.can_save) {
        installed.save.set_enabled(save_enabled)?;
    }
    if f.has_document != prev.has_document || f.save_as_only != prev.save_as_only {
        let (save_accel, save_as_accel) = save_accelerators(f.has_document, f.save_as_only);
        installed.save.set_accelerator(save_accel)?;
        installed.save_as.set_accelerator(save_as_accel)?;
    }

    if f.can_save_all != prev.can_save_all {
        installed.save_all.set_enabled(f.can_save_all)?;
    }
    if f.can_close_all != prev.can_close_all {
        installed.close_all.set_enabled(f.can_close_all)?;
    }

    let undo_enabled = f.typing_target || (f.has_document && f.can_undo);
    if undo_enabled != (prev.typing_target || (prev.has_document && prev.can_undo)) {
        installed.undo.set_enabled(undo_enabled)?;
    }
    let redo_enabled = f.typing_target || (f.has_document && f.can_redo);
    if redo_enabled != (prev.typing_target || (prev.has_document && prev.can_redo)) {
        installed.redo.set_enabled(redo_enabled)?;
    }
    let select_all_enabled = f.typing_target || f.has_document;
    if select_all_enabled != (prev.typing_target || prev.has_document) {
        installed.select_all.set_enabled(select_all_enabled)?;
    }

    if f.has_document != prev.has_document || f.active_tool != prev.active_tool {
        sync_tool_checkmarks(installed, f)?;
    }

    if f.has_document != prev.has_document || f.book_applies != prev.book_applies {
        installed
            .book
            .set_enabled(f.has_document && f.book_applies)?;
    }
    if f.has_document != prev.has_document || f.view_mode != prev.view_mode {
        sync_view_mode_checkmarks(installed, f)?;
    }

    let zoom_in_enabled = f.has_document && f.zoom_can_in;
    if zoom_in_enabled != (prev.has_document && prev.zoom_can_in) {
        installed.zoom_in.set_enabled(zoom_in_enabled)?;
    }
    let zoom_out_enabled = f.has_document && f.zoom_can_out;
    if zoom_out_enabled != (prev.has_document && prev.zoom_can_out) {
        installed.zoom_out.set_enabled(zoom_out_enabled)?;
    }

    let recent_entries = clamp_recent_entries(&snapshot.recent_files);
    if recent_entries != installed.recent_entries {
        let recent_generation = replace_recent_registry(state, &recent_entries);
        populate_recent_submenu(
            app,
            &installed.open_recent,
            &snapshot.static_labels.recent_empty,
            recent_generation,
            &recent_entries,
        )?;
        installed.recent_entries = recent_entries;
    }

    installed.dynamic_labels = d.clone();
    installed.flags = f.clone();
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_snapshot_locked(
    app: &AppHandle,
    state: &NativeMenuState,
    snapshot: &MacMenuSnapshot,
) -> Result<(), String> {
    let can_update_in_place = state
        .installed
        .lock()
        .map_err(|_| "menu state poisoned".to_string())?
        .as_ref()
        .is_some_and(|installed| {
            !needs_menu_rebuild(
                &installed.static_labels,
                &installed.flags,
                &snapshot.static_labels,
                &snapshot.flags,
            )
        });

    if can_update_in_place {
        let mut guard = state
            .installed
            .lock()
            .map_err(|_| "menu state poisoned".to_string())?;
        if let Some(installed) = guard.as_mut() {
            return update_installed_menu(app, state, installed, snapshot)
                .map_err(|e| e.to_string());
        }
    }

    let (menu, next_installed) =
        build_installed_menu(app, state, snapshot).map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    if let Ok(mut guard) = state.installed.lock() {
        *guard = Some(next_installed);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn reconcile_active_menu(app: &AppHandle, gone: Option<&str>) -> Result<(), String> {
    let state = app.state::<NativeMenuState>();
    // Serialized off the main thread because tauri::menu methods dispatch onto
    // the main thread and block for completion. Acquire `apply_lock` before
    // choosing the target window so concurrent focus/sync/destroy events cannot
    // overwrite a newer active window's menu with a stale snapshot.
    let _guard = state
        .apply_lock
        .lock()
        .map_err(|_| "menu lock poisoned".to_string())?;

    let snapshot = windows::focus_target_except(app, gone).and_then(|target| {
        state.snapshots.lock().ok().and_then(|snapshots| {
            snapshots
                .get(target.label())
                .map(|entry| entry.snapshot.clone())
        })
    });

    let Some(snapshot) = snapshot else {
        return Ok(());
    };

    apply_snapshot_locked(app, &state, &snapshot)
}

#[cfg(target_os = "macos")]
fn reconcile_checkmarks_async(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<NativeMenuState>() else {
            return;
        };
        let Ok(_guard) = state.apply_lock.lock() else {
            return;
        };
        let Ok(guard) = state.installed.lock() else {
            return;
        };
        if let Some(installed) = guard.as_ref() {
            let _ = sync_tool_checkmarks(installed, &installed.flags);
            let _ = sync_view_mode_checkmarks(installed, &installed.flags);
        }
    });
}

#[cfg(target_os = "macos")]
fn take_context_result(state: &NativeMenuState, seq: u64) -> Option<String> {
    state
        .context_results
        .lock()
        .ok()
        .and_then(|mut results| results.remove(&seq))
}

#[cfg(target_os = "macos")]
pub fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();

    if id == quit::QUIT_MENU_ID {
        quit::request_quit(app);
        return;
    }

    if id == HELP_WEBSITE_ID {
        tauri::async_runtime::spawn_blocking(|| {
            let _ = tauri_plugin_opener::open_url(HELP_URL, None::<&str>);
        });
        return;
    }

    if let Some((seq, action_id)) = parse_context_item_id(id) {
        if let Some(state) = app.try_state::<NativeMenuState>() {
            if let Ok(mut results) = state.context_results.lock() {
                results.insert(seq, action_id);
            }
        }
        return;
    }

    if let Some((generation, index)) = parse_recent_item_id(id) {
        let path = app.try_state::<NativeMenuState>().and_then(|state| {
            state
                .recent_registry
                .lock()
                .ok()
                .and_then(|registry| registry.resolve(generation, index).map(str::to_owned))
        });
        if let Some(path) = path {
            if let Some(window) = windows::focus_target(app) {
                let _ = app.emit_to(
                    window.label(),
                    MENU_ACTION_EVENT,
                    MenuActionPayload {
                        id: "file-open-recent".into(),
                        path: Some(path),
                    },
                );
            }
        }
        return;
    }

    if is_checkable_menu_id(id) {
        // AppKit toggles CheckMenuItem state automatically on click; reconcile
        // back to `installed.flags` until the frontend sends the updated state.
        reconcile_checkmarks_async(app);
    }

    if let Some(window) = windows::focus_target(app) {
        let _ = app.emit_to(
            window.label(),
            MENU_ACTION_EVENT,
            MenuActionPayload {
                id: id.to_string(),
                path: None,
            },
        );
    }
}

#[cfg(target_os = "macos")]
fn sync_active_window_menu_async(app: &AppHandle, gone: Option<&str>) {
    let app = app.clone();
    let gone = gone.map(ToOwned::to_owned);

    tauri::async_runtime::spawn(async move {
        let _ = reconcile_active_menu(&app, gone.as_deref());
    });
}

#[cfg(target_os = "macos")]
pub fn on_window_focused(app: &AppHandle) {
    sync_active_window_menu_async(app, None);
}

#[cfg(target_os = "macos")]
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<NativeMenuState>() {
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.remove(label);
        }
    }
    sync_active_window_menu_async(app, Some(label));
}

#[tauri::command]
pub async fn sync_macos_menu(
    app: AppHandle,
    window: WebviewWindow,
    seq: u64,
    snapshot: MacMenuSnapshot,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<NativeMenuState>();
        let page = windows::page_generation(&window);
        let label = window.label().to_string();
        let accepted = {
            let mut snapshots = state
                .snapshots
                .lock()
                .map_err(|_| "menu snapshots poisoned".to_string())?;
            let current = snapshots.get(&label).map(|entry| (entry.page, entry.seq));
            if should_accept_snapshot(current, (page, seq)) {
                snapshots.insert(
                    label,
                    StoredWindowSnapshot {
                        page,
                        seq,
                        snapshot,
                    },
                );
                true
            } else {
                false
            }
        };

        if accepted {
            reconcile_active_menu(&app, None)?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, seq, snapshot);
    }

    Ok(())
}

#[tauri::command]
pub async fn popup_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<NativeContextMenuItem>,
    at: Option<NativeMenuPoint>,
) -> Result<Option<String>, String> {
    validate_context_items(&items)?;
    validate_menu_point(at)?;
    if items.is_empty() {
        return Ok(None);
    }

    #[cfg(target_os = "macos")]
    {
        let state = app.state::<NativeMenuState>();
        let _popup_guard = state.popup_lock.lock().await;
        let seq = state.context_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = take_context_result(&state, seq);

        let menu = Menu::new(&app).map_err(|error| error.to_string())?;
        for item in items {
            match item {
                NativeContextMenuItem::Item {
                    id,
                    label,
                    enabled,
                    checked,
                } => {
                    let id = format_context_item_id(seq, &id);
                    let label = escape_mnemonic(&label);
                    if let Some(checked) = checked {
                        let menu_item =
                            CheckMenuItem::with_id(&app, id, label, enabled, checked, None::<&str>)
                                .map_err(|error| error.to_string())?;
                        menu.append(&menu_item).map_err(|error| error.to_string())?;
                    } else {
                        let menu_item = MenuItem::with_id(&app, id, label, enabled, None::<&str>)
                            .map_err(|error| error.to_string())?;
                        menu.append(&menu_item).map_err(|error| error.to_string())?;
                    }
                }
                NativeContextMenuItem::Separator => {
                    let sep =
                        PredefinedMenuItem::separator(&app).map_err(|error| error.to_string())?;
                    menu.append(&sep).map_err(|error| error.to_string())?;
                }
            }
        }

        if let Ok(mut last_popup) = state.last_popup.lock() {
            *last_popup = Some(menu.clone());
        }

        let shown = match at {
            Some(NativeMenuPoint { x, y }) => {
                window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
            }
            None => window.popup_menu(&menu),
        };
        if let Err(error) = shown {
            let _ = take_context_result(&state, seq);
            return Err(error.to_string());
        }

        // `muda` enqueues `EventLoopMessage::MenuEvent` on the main loop when
        // an item is clicked during `popUpMenu`; wait one main-thread turn so
        // `handle_menu_event` writes `context_results` before we read it.
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        if let Err(error) = window.run_on_main_thread(move || {
            let _ = sender.try_send(());
        }) {
            let _ = take_context_result(&state, seq);
            return Err(error.to_string());
        }
        let _ = receiver.recv().await;

        Ok(take_context_result(&state, seq))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, at);
        Ok(None)
    }
}

#[tauri::command]
pub async fn write_clipboard_text(window: WebviewWindow, text: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if text.is_empty() {
            return Ok(true);
        }

        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        window
            .run_on_main_thread(move || {
                use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
                use objc2_foundation::NSString;

                let pasteboard = NSPasteboard::generalPasteboard();
                pasteboard.clearContents();
                let ns_text = NSString::from_str(&text);
                // SAFETY: `NSPasteboardTypeString` is AppKit's static UTType constant.
                let ok = pasteboard.setString_forType(&ns_text, unsafe { NSPasteboardTypeString });
                let _ = sender.try_send(ok);
            })
            .map_err(|error| error.to_string())?;

        receiver
            .recv()
            .await
            .ok_or_else(|| "window closed before clipboard write completed".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, text);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_item_ids_round_trip() {
        let id = format_context_item_id(42, "rotate-pages");
        assert_eq!(id, "ctx:42:rotate-pages");
        assert_eq!(
            parse_context_item_id(&id),
            Some((42, "rotate-pages".into()))
        );
    }

    #[test]
    fn context_item_id_parser_rejects_malformed_ids() {
        assert_eq!(parse_context_item_id("ctx:abc:rotate"), None);
        assert_eq!(parse_context_item_id("ctx:12:"), None);
        assert_eq!(parse_context_item_id("other:12:rotate"), None);
    }

    #[test]
    fn recent_item_id_round_trips_and_rejects_malformed_ids() {
        let id = format_recent_item_id(3, 7);
        assert_eq!(id, "recent:3:7");
        assert_eq!(parse_recent_item_id(&id), Some((3, 7)));
        assert_eq!(parse_recent_item_id("recent:7"), None);
        assert_eq!(parse_recent_item_id("recent:abc:7"), None);
        assert_eq!(parse_recent_item_id("recent:3:-1"), None);
        assert_eq!(parse_recent_item_id("file-open"), None);
    }

    #[test]
    fn recent_registry_ignores_retired_generations() {
        let mut registry = RecentMenuRegistry::default();
        let gen1 = registry.replace(vec!["/tmp/a.pdf".into(), "/tmp/b.pdf".into()]);
        assert_eq!(gen1, 1);
        assert_eq!(registry.resolve(gen1, 0), Some("/tmp/a.pdf"));
        assert_eq!(registry.resolve(gen1, 1), Some("/tmp/b.pdf"));

        let gen2 = registry.replace(vec!["/tmp/c.pdf".into()]);
        assert_eq!(gen2, 2);
        assert_eq!(registry.resolve(gen1, 0), None);
        assert_eq!(registry.resolve(gen2, 0), Some("/tmp/c.pdf"));
        assert_eq!(registry.resolve(gen2, 1), None);
    }

    fn sample_labels() -> MacMenuStaticLabels {
        MacMenuStaticLabels {
            app_name: "TFolio".into(),
            file: "File".into(),
            new_doc: "New".into(),
            new_window: "New Window".into(),
            open: "Open...".into(),
            open_recent: "Open Recent".into(),
            recent_empty: "No Recent Files".into(),
            add_files: "Add Files...".into(),
            save: "Save".into(),
            save_all: "Save All".into(),
            save_as: "Save As...".into(),
            fit_a4: "Fit to A4".into(),
            export_images: "Export as Images".into(),
            split: "Split".into(),
            compress: "Compress".into(),
            close_tab: "Close Tab".into(),
            close_all: "Close All Tabs".into(),
            close_window: "Close Window".into(),
            edit: "Edit".into(),
            cut: "Cut".into(),
            copy: "Copy".into(),
            paste: "Paste".into(),
            select_all: "Select All".into(),
            find: "Find...".into(),
            tools: "Tools".into(),
            highlight: "Highlight".into(),
            rect: "Rectangle".into(),
            text_note: "Note".into(),
            eraser: "Eraser".into(),
            watermark: "Watermark".into(),
            page_numbers: "Page Numbers".into(),
            view: "View".into(),
            single_page: "Single Page".into(),
            book: "Book".into(),
            zoom_in: "Zoom In".into(),
            zoom_out: "Zoom Out".into(),
            zoom_reset: "Reset Zoom".into(),
            zoom_fit_width: "Fit Width".into(),
            zoom_fit_page: "Fit Page".into(),
            enter_full_screen: "Enter Full Screen".into(),
            window: "Window".into(),
            minimize: "Minimize".into(),
            maximize: "Zoom".into(),
            help: "Help".into(),
            app_help: "TFolio Help".into(),
            about_app: "About TFolio".into(),
            check_updates: "Check for Updates...".into(),
            settings: "Settings...".into(),
            services: "Services".into(),
            hide_app: "Hide TFolio".into(),
            hide_others: "Hide Others".into(),
            show_all: "Show All".into(),
            quit_app: "Quit TFolio".into(),
        }
    }

    fn sample_flags(has_document: bool, save_as_only: bool) -> MacMenuFlags {
        MacMenuFlags {
            has_document,
            can_save: true,
            can_save_all: false,
            save_as_only,
            can_close_all: has_document,
            can_undo: false,
            can_redo: false,
            typing_target: false,
            active_tool: None,
            view_mode: None,
            book_applies: false,
            zoom_can_in: true,
            zoom_can_out: true,
        }
    }

    #[test]
    fn needs_menu_rebuild_when_accelerator_is_removed() {
        let labels = sample_labels();
        let doc_flags = sample_flags(true, false);
        let home_flags = sample_flags(false, false);
        let save_as_only_flags = sample_flags(true, true);

        // Removing close_tab or save accelerator must trigger full menu rebuild.
        assert!(needs_menu_rebuild(
            &labels,
            &doc_flags,
            &labels,
            &home_flags
        ));
        assert!(needs_menu_rebuild(
            &labels,
            &doc_flags,
            &labels,
            &save_as_only_flags
        ));

        // Adding or keeping accelerators updates in place.
        assert!(!needs_menu_rebuild(
            &labels,
            &home_flags,
            &labels,
            &doc_flags
        ));
        assert!(!needs_menu_rebuild(
            &labels,
            &save_as_only_flags,
            &labels,
            &doc_flags
        ));

        let mut other_labels = labels.clone();
        other_labels.file = "Datei".into();
        assert!(needs_menu_rebuild(
            &labels,
            &doc_flags,
            &other_labels,
            &doc_flags
        ));
    }

    #[test]
    fn checkable_menu_id_matches_tool_and_view_toggles() {
        assert!(is_checkable_menu_id("tool-highlight"));
        assert!(is_checkable_menu_id("tool-rect"));
        assert!(is_checkable_menu_id("tool-text-note"));
        assert!(is_checkable_menu_id("tool-eraser"));
        assert!(is_checkable_menu_id("view-single"));
        assert!(is_checkable_menu_id("view-book"));
        assert!(!is_checkable_menu_id("file-save"));
        assert!(!is_checkable_menu_id("view-toggle-sidebar"));
    }

    #[test]
    fn should_accept_snapshot_enforces_monotonic_page_and_seq() {
        assert!(should_accept_snapshot::<(u64, u64)>(None, (1, 1)));
        assert!(should_accept_snapshot(Some((1, 1)), (1, 2)));
        assert!(!should_accept_snapshot(Some((1, 2)), (1, 2)));
        assert!(!should_accept_snapshot(Some((1, 3)), (1, 2)));
        // A higher page generation resets sequence numbers on reload.
        assert!(should_accept_snapshot(Some((1, 99)), (2, 1)));
        assert!(!should_accept_snapshot(Some((2, 1)), (1, 100)));
    }

    #[test]
    fn clamp_recent_caps_at_limit() {
        let entries: Vec<RecentMenuEntry> = (0..15)
            .map(|i| RecentMenuEntry {
                name: format!("doc-{i}.pdf"),
                path: format!("/tmp/doc-{i}.pdf"),
            })
            .collect();
        let clamped = clamp_recent_entries(&entries);
        assert_eq!(clamped.len(), MAX_RECENT_MENU_ITEMS);
        assert_eq!(clamped[0].name, "doc-0.pdf");
        assert_eq!(clamped[9].name, "doc-9.pdf");
    }

    #[test]
    fn validate_context_items_checks_count_and_ids() {
        let valid = vec![
            NativeContextMenuItem::Item {
                id: "copy".into(),
                label: "Copy".into(),
                enabled: true,
                checked: None,
            },
            NativeContextMenuItem::Separator,
        ];
        assert!(validate_context_items(&valid).is_ok());

        let empty_id = vec![NativeContextMenuItem::Item {
            id: String::new(),
            label: "Broken".into(),
            enabled: true,
            checked: None,
        }];
        assert!(validate_context_items(&empty_id).is_err());

        let too_many: Vec<NativeContextMenuItem> = (0..=MAX_CONTEXT_MENU_ITEMS)
            .map(|i| NativeContextMenuItem::Item {
                id: format!("item-{i}"),
                label: format!("Item {i}"),
                enabled: true,
                checked: None,
            })
            .collect();
        assert!(validate_context_items(&too_many).is_err());
    }

    #[test]
    fn context_items_read_checked_only_when_given() {
        let items: Vec<NativeContextMenuItem> = serde_json::from_str(
            r#"[
                {"kind": "item", "id": "a", "label": "A"},
                {"kind": "item", "id": "b", "label": "B", "checked": false},
                {"kind": "separator"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            items,
            vec![
                NativeContextMenuItem::Item {
                    id: "a".into(),
                    label: "A".into(),
                    enabled: true,
                    checked: None,
                },
                NativeContextMenuItem::Item {
                    id: "b".into(),
                    label: "B".into(),
                    enabled: true,
                    checked: Some(false),
                },
                NativeContextMenuItem::Separator,
            ]
        );
    }

    #[test]
    fn validate_menu_point_rejects_unplaceable_positions() {
        assert!(validate_menu_point(None).is_ok());
        assert!(validate_menu_point(Some(NativeMenuPoint { x: 12.5, y: 40.0 })).is_ok());
        assert!(validate_menu_point(Some(NativeMenuPoint { x: -3.0, y: 0.0 })).is_ok());
        assert!(validate_menu_point(Some(NativeMenuPoint {
            x: f64::NAN,
            y: 0.0
        }))
        .is_err());
        assert!(validate_menu_point(Some(NativeMenuPoint { x: 0.0, y: 2e6 })).is_err());
    }

    #[test]
    fn escape_mnemonic_keeps_ampersands_in_labels() {
        assert_eq!(escape_mnemonic("R&D.pdf"), "R&&D.pdf");
        assert_eq!(escape_mnemonic("Plain"), "Plain");
    }

    #[test]
    fn save_accelerators_follow_save_as_only_state() {
        assert_eq!(
            save_accelerators(false, false),
            (Some("CmdOrCtrl+S"), Some("CmdOrCtrl+Shift+S"))
        );
        assert_eq!(
            save_accelerators(true, false),
            (Some("CmdOrCtrl+S"), Some("CmdOrCtrl+Shift+S"))
        );
        assert_eq!(save_accelerators(true, true), (None, Some("CmdOrCtrl+S")));
    }

    #[test]
    fn close_accelerators_follow_active_document() {
        assert_eq!(close_accelerators(false), (None, Some("CmdOrCtrl+W")));
        assert_eq!(
            close_accelerators(true),
            (Some("CmdOrCtrl+W"), Some("CmdOrCtrl+Shift+W"))
        );
    }
}
