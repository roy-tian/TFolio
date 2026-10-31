//! The PDF engine apart from any app shell: the host resolves where things
//! live (`EnginePaths`) and keeps these blocking calls off its UI thread.

mod convert;
mod pdfium;

pub use convert::{is_word_document, WordSuites, WORD_EXTENSIONS};
pub use pdfium::{
    download_fallback_font, is_merge_image, size_limit_error, ArchiveOptions, AssembleOutlineItem,
    AssemblePlan, AssembleSlot, CompressionEstimate, CompressionOptions, EnginePaths,
    ExportOutcome, ImageFormat, InsertOutcome, OperationTarget, OrganizeSourceInfo,
    PageNumbersConfig, PageNumbersPreferences, PagePoint, PagePointsRect, PdfDocumentInfo,
    PdfSearchOutcome, PdfStructureUpdate, PdfTextSpan, PdfiumEngine, RectEffect, RectStyle,
    TextNoteStyle, WatermarkConfig, CJK_FONT_NAME, MAX_PDF_BYTES, MERGE_IMAGE_EXTENSIONS,
    ORGANIZE_SOURCE_CHANGED, PDFIUM_LIBRARY_NAME,
};
