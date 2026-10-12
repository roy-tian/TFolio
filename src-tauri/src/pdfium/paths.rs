use std::{
    env,
    path::{Path, PathBuf},
};

use tauri::{path::BaseDirectory, AppHandle, Manager};
use tfolio_engine::{EnginePaths, CJK_FONT_NAME, PDFIUM_LIBRARY_NAME};

/// Resolved once at startup, the only point an `AppHandle` reaches the engine.
pub(super) fn engine_paths(app: &AppHandle) -> EnginePaths {
    EnginePaths {
        library_candidates: pdfium_library_candidates(app),
        fallback_font_candidates: fallback_font_candidates(app),
        conversion_root: conversion_root(app),
        retired_conversion_roots: retired_conversion_roots(app),
    }
}

fn pdfium_library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("PDFIUM_LIB_PATH") {
        candidates.push(library_path(PathBuf::from(path)));
    }

    if let Ok(resource_path) = app.path().resolve(
        Path::new("pdfium").join(PDFIUM_LIBRARY_NAME),
        BaseDirectory::Resource,
    ) {
        candidates.push(resource_path);
    }

    if let Ok(executable_path) = env::current_exe() {
        if let Some(executable_directory) = executable_path.parent() {
            candidates.push(executable_directory.join(PDFIUM_LIBRARY_NAME));
        }
    }

    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium")
            .join(PDFIUM_LIBRARY_NAME),
    );
    candidates.into_iter().fold(Vec::new(), |mut unique, path| {
        if !unique.contains(&path) {
            unique.push(path);
        }

        unique
    })
}

fn library_path(path: PathBuf) -> PathBuf {
    if path.is_dir() {
        path.join(PDFIUM_LIBRARY_NAME)
    } else {
        path
    }
}

/// Existence is deliberately not checked: the fallback arrives only when a
/// reader accepts the download.
fn fallback_font_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("TFOLIO_FONT_PATH") {
        let path = PathBuf::from(path);

        if path.is_dir() {
            candidates.push(path.join(CJK_FONT_NAME));
        } else if path.file_name().is_some_and(|file| file == CJK_FONT_NAME) {
            candidates.push(path);
        }
    }

    if let Some(downloaded) = fallback_font_destination(app) {
        candidates.push(downloaded);
    }

    if let Ok(resource_path) = app.path().resolve(
        Path::new("fonts").join(CJK_FONT_NAME),
        BaseDirectory::Resource,
    ) {
        candidates.push(resource_path);
    }

    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("fonts")
            .join(CJK_FONT_NAME),
    );
    candidates
}

/// The app's own data directory, not the resource directory: an `.app` bundle
/// or `/usr` install is read-only, and where it is not, the bundle is signed.
pub(super) fn fallback_font_destination(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join("fonts").join(CJK_FONT_NAME))
}

/// The user's TEMP, which Office itself must be free to write: a
/// document-control agent (IP-guard) let Word read a staged copy under the
/// AppData cache but silently dropped the PDF it exported beside it.
#[cfg(windows)]
fn conversion_root(app: &AppHandle) -> Option<PathBuf> {
    let identifier = &app.config().identifier;

    app.path()
        .temp_dir()
        .ok()
        .map(|directory| directory.join(identifier))
}

/// Elsewhere the per-user cache: Linux's temp directory is the shared `/tmp`.
#[cfg(not(windows))]
fn conversion_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok()
}

/// Earlier releases converted under the AppData cache on Windows too.
#[cfg(windows)]
fn retired_conversion_roots(app: &AppHandle) -> Vec<PathBuf> {
    app.path().app_cache_dir().into_iter().collect()
}

#[cfg(not(windows))]
fn retired_conversion_roots(_app: &AppHandle) -> Vec<PathBuf> {
    Vec::new()
}
