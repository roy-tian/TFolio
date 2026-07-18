use std::{
    env,
    path::{Path, PathBuf},
};

use pdfium_render::prelude::*;
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[cfg(target_os = "windows")]
pub(super) const PDFIUM_LIBRARY_NAME: &str = "pdfium.dll";
#[cfg(target_os = "macos")]
pub(super) const PDFIUM_LIBRARY_NAME: &str = "libpdfium.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
pub(super) const PDFIUM_LIBRARY_NAME: &str = "libpdfium.so";

pub(super) fn bind_pdfium(app: &AppHandle) -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let candidates = pdfium_library_candidates(app);
    let mut failures = Vec::new();

    for path in candidates {
        if !path.is_file() {
            continue;
        }

        match Pdfium::bind_to_library(&path) {
            Ok(bindings) => return Ok(bindings),
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }

    let details = if failures.is_empty() {
        String::new()
    } else {
        format!(" Attempts: {}", failures.join("; "))
    };

    Err(format!(
        "PDFium runtime was not found. Run `bun run pdfium:download` or set PDFIUM_LIB_PATH.{details}"
    ))
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
