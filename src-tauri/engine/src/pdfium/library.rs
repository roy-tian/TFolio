use std::path::{Path, PathBuf};

use pdfium_render::prelude::*;

#[cfg(target_os = "windows")]
pub const PDFIUM_LIBRARY_NAME: &str = "pdfium.dll";
#[cfg(target_os = "macos")]
pub const PDFIUM_LIBRARY_NAME: &str = "libpdfium.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
pub const PDFIUM_LIBRARY_NAME: &str = "libpdfium.so";

pub(super) type Bindings = Box<dyn PdfiumLibraryBindings>;

/// pdfium-render keeps the bindings `Pdfium::new` takes to itself, so the raw
/// calls it has no wrapper for go through a second binding of the same loaded
/// library. Both bind first: once `Pdfium::new` runs, every bind is refused.
pub(super) fn bind_library_twice(path: &Path) -> Result<(Bindings, Bindings), PdfiumError> {
    Ok((
        Pdfium::bind_to_library(path)?,
        Pdfium::bind_to_library(path)?,
    ))
}

pub(super) fn bind_pdfium(candidates: &[PathBuf]) -> Result<(Bindings, Bindings), String> {
    let mut failures = Vec::new();

    for path in candidates {
        if !path.is_file() {
            continue;
        }

        match bind_library_twice(path) {
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
