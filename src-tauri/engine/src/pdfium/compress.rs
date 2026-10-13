use serde::{Deserialize, Serialize};

/// The level is bounded by the engine, not by the choices that usually pick
/// it: a command's arguments are anyone's to send.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionOptions {
    /// The resolution images are resampled toward, in pixels per inch of
    /// their drawn size. `None` leaves the images' bytes untouched and
    /// compresses structure alone.
    pub image_dpi: Option<u32>,
}

/// The dialog's bottom line. `estimated_bytes` is the pipeline's own output,
/// exactly what the export will write; `original_bytes` is the opened file's
/// length until an edit or a write, then PDFium's rewrite of the document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionEstimate {
    pub(in crate::pdfium) original_bytes: u64,
    pub(in crate::pdfium) estimated_bytes: u64,
}

impl CompressionEstimate {
    pub(in crate::pdfium) fn new(original_bytes: u64, estimated_bytes: u64) -> Self {
        Self {
            original_bytes,
            estimated_bytes,
        }
    }
}
