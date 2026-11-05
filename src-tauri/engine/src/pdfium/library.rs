use std::path::PathBuf;

use pdfium_render::prelude::*;

#[cfg(target_os = "windows")]
pub const PDFIUM_LIBRARY_NAME: &str = "pdfium.dll";
#[cfg(target_os = "macos")]
pub const PDFIUM_LIBRARY_NAME: &str = "libpdfium.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
pub const PDFIUM_LIBRARY_NAME: &str = "libpdfium.so";

pub(super) fn bind_pdfium(
    candidates: &[PathBuf],
) -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let mut failures = Vec::new();

    for path in candidates {
        if !path.is_file() {
            continue;
        }

        match Pdfium::bind_to_library(path) {
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
