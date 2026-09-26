use super::io::{
    is_merge_image, load_merge_source, merge_file_limit_error, read_image, read_pdf_bytes,
    SourceFile, MAX_MERGE_FILES,
};
use super::*;

pub(super) fn is_a4_size(width: f32, height: f32) -> bool {
    // PDFs commonly round A4 dimensions to whole points.
    const TOLERANCE: f32 = 1.0;
    width.is_finite()
        && height.is_finite()
        && (width.min(height) - A4_SHORT_POINTS).abs() <= TOLERANCE
        && (width.max(height) - A4_LONG_POINTS).abs() <= TOLERANCE
}

/// Sized without loading a page: loading parses its content, which a size
/// check has no use for and a 400-page file pays a hundred times over for.
fn document_is_a4(document: &PdfDocument<'_>, cancelled: &impl Fn() -> bool) -> Option<bool> {
    let pages = document.pages();

    if pages.is_empty() {
        return None;
    }
    for index in 0..pages.len() {
        if cancelled() {
            return None;
        }
        let size = pages.page_size(index).ok()?;
        if !is_a4_size(size.width().value, size.height().value) {
            return Some(false);
        }
    }
    Some(true)
}

/// What the wizard's row needs of a PDF that opened.
struct PdfFacts {
    page_count: PdfPageIndex,
    all_pages_a4: Option<bool>,
    has_outline: bool,
}

impl PdfiumEngine {
    /// Read off the disk without the lock, and measured under it — each file
    /// taking it for itself, so an inspection of many parks no render for long.
    /// `None` is a file PDFium cannot open.
    fn inspect_pdf(&self, path: &Path, cancelled: &impl Fn() -> bool) -> Option<PdfFacts> {
        let bytes = read_pdf_bytes(path).ok()?;
        let _documents = self.lock_documents().ok()?;
        // Declared after the guard, so closed before it is given back.
        let document = load_merge_source(self.pdfium, SourceFile::Pdf(bytes), path).ok()?;

        Some(PdfFacts {
            page_count: document.pages().len(),
            all_pages_a4: document_is_a4(&document, cancelled),
            has_outline: document.bookmarks().root().is_some(),
        })
    }

    /// Reads each merge candidate just far enough for the wizard's first step.
    /// An unreadable file is reported as such, so its row stays and says why.
    pub(in crate::pdfium) fn inspect_files(
        &self,
        window: &str,
        paths: Vec<PathBuf>,
        word_conversion: bool,
    ) -> Result<Vec<PdfFileSummary>, String> {
        if paths.len() > MAX_MERGE_FILES {
            return Err(merge_file_limit_error());
        }

        // A Word file has no page count until an office suite makes a PDF of it
        // — seconds, another process's — so it runs before the lock, stoppable.
        let operation = self.begin_operation(OperationTarget::Convert(window.to_string()));
        let cancelled = || operation.is_cancelled();
        let word = self.resolve_word_documents(&paths, word_conversion, &cancelled, &mut || {});

        // Decoded exactly as the merge will, so a usable row is really usable;
        // only decoded, and before the lock, since a decode is no PDFium work.
        let images: Vec<Option<bool>> = paths
            .iter()
            .map(|path| is_merge_image(path).then(|| read_image(path).is_ok()))
            .collect();

        Ok(paths
            .into_iter()
            .zip(images)
            .zip(word)
            .take_while(|_| !cancelled())
            .map(|((path, image), word)| {
                let path_text = path.to_string_lossy().into_owned();

                // A converted Word file reads like any PDF, under the row's own
                // name: the row says what the file is, not what conversion left.
                if let crate::convert::Entry::Converted(pdf) = &word {
                    return match self.inspect_pdf(pdf, &cancelled) {
                        Some(facts) => PdfFileSummary {
                            path: path_text,
                            kind: MergeSourceKind::Word,
                            page_count: (facts.page_count >= 1).then_some(facts.page_count),
                            all_pages_a4: facts.all_pages_a4,
                            has_outline: facts.has_outline,
                            error: None,
                        },
                        // The conversion returned something this app's own
                        // reader cannot open — rarer than a refusal, same wording.
                        None => PdfFileSummary {
                            path: path_text,
                            kind: MergeSourceKind::Word,
                            page_count: None,
                            all_pages_a4: None,
                            has_outline: false,
                            error: Some(MergeSourceError::ConversionFailed),
                        },
                    };
                }

                if let crate::convert::Entry::Failed(error) = word {
                    return PdfFileSummary {
                        path: path_text,
                        kind: MergeSourceKind::Word,
                        page_count: None,
                        all_pages_a4: None,
                        has_outline: false,
                        error: Some(match error {
                            crate::convert::ConvertError::NoConverter => {
                                MergeSourceError::ConverterMissing
                            }
                            crate::convert::ConvertError::Failed(_) => {
                                MergeSourceError::ConversionFailed
                            }
                        }),
                    };
                }

                if let Some(readable) = image {
                    return PdfFileSummary {
                        path: path_text,
                        kind: MergeSourceKind::Image,
                        page_count: readable.then_some(1),
                        all_pages_a4: readable.then_some(true),
                        has_outline: false,
                        error: None,
                    };
                }

                match self.inspect_pdf(&path, &cancelled) {
                    Some(facts) => PdfFileSummary {
                        path: path_text,
                        kind: MergeSourceKind::Pdf,
                        page_count: (facts.page_count >= 1).then_some(facts.page_count),
                        all_pages_a4: facts.all_pages_a4,
                        has_outline: facts.has_outline,
                        error: None,
                    },
                    None => PdfFileSummary {
                        path: path_text,
                        kind: MergeSourceKind::Pdf,
                        page_count: None,
                        all_pages_a4: None,
                        has_outline: false,
                        error: None,
                    },
                }
            })
            .collect())
    }
}
