use super::*;
use crate::pdfium::compress::{CompressionEstimate, CompressionOptions};

// The levels the WebView's sliders pick, bounded here because a command's
// arguments are anyone's to send.
const MIN_RASTER_DPI: u32 = 72;
const MAX_RASTER_DPI: u32 = 300;
const MIN_JPEG_QUALITY: u32 = 10;
const MAX_JPEG_QUALITY: u32 = 100;

// Enough pages to meet both a page of text and one of photographs, few enough
// to answer while a slider is still moving.
const ESTIMATE_SAMPLE_PAGES: usize = 5;

// What a page's share of structure adds on top of its image: page and image
// objects, and the xref row each costs — measured on this module's own output.
const ESTIMATE_PAGE_OVERHEAD: u64 = 1024;

fn raster_levels(options: CompressionOptions) -> Result<RasterLevels, String> {
    let CompressionOptions::Rasterized { dpi, quality } = options else {
        return Err("a lossless compression has no raster levels".into());
    };

    if !(MIN_RASTER_DPI..=MAX_RASTER_DPI).contains(&dpi) {
        return Err(format!(
            "a rasterized page needs between {MIN_RASTER_DPI} and {MAX_RASTER_DPI} dpi, not {dpi}"
        ));
    }

    if !(MIN_JPEG_QUALITY..=MAX_JPEG_QUALITY).contains(&quality) {
        return Err(format!(
            "JPEG quality must sit between {MIN_JPEG_QUALITY} and {MAX_JPEG_QUALITY}, not {quality}"
        ));
    }

    Ok(RasterLevels { dpi, quality })
}

/// Page `step` of a spread of `ESTIMATE_SAMPLE_PAGES` across `pages`, so the
/// first and last page both speak and the middle is met on its way between.
fn sampled_page_index(step: usize, pages: usize) -> PdfPageIndex {
    let samples = pages.min(ESTIMATE_SAMPLE_PAGES);

    if samples <= 1 {
        return 0;
    }

    (step * (pages - 1) / (samples - 1)) as PdfPageIndex
}

/// The lossless pipeline's pair — what PDFium wrote, and what lopdf made of
/// it. `None` reports a stop read between the stages.
type LosslessBytes = Option<(Vec<u8>, Vec<u8>)>;

/// PDFium's full rewrite — where unreferenced objects drop off — then lopdf's
/// object and cross-reference streams at flate's deepest level. lopdf reads
/// only bytes PDFium itself just wrote, the same arrangement as the outline
/// writer; both outputs come back because the pair is the lossless estimate.
/// Each stage is one whole document long, which is exactly where a reader's
/// patience runs out, so the stops are read between them.
fn lossless_output(
    document: &PdfDocument<'_>,
    operation: &OperationGuard<'_>,
) -> Result<LosslessBytes, String> {
    let rewritten = document
        .save_to_bytes()
        .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;

    if operation.is_cancelled() {
        return Ok(None);
    }

    let mut loaded = lopdf::Document::load_mem(&rewritten)
        .map_err(|error| format!("the rewritten document could not be reread: {error}"))?;

    // Streams no filter ever covered are the ones flate can still take;
    // already-filtered ones (page content, images) pass through untouched.
    loaded.compress();

    // Object streams are a 1.5 feature, so a header older than that would
    // misdescribe the file about to be written. Real version strings run
    // 1.0–1.7 then 2.0, where lexicographic order is numeric order.
    if loaded.version.as_str() < "1.5" {
        loaded.version = "1.5".to_string();
    }

    if operation.is_cancelled() {
        return Ok(None);
    }

    let options = lopdf::SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(9)
        .build();
    let mut compressed = Vec::with_capacity(rewritten.len());
    loaded
        .save_with_options(&mut compressed, options)
        .map_err(|error| format!("the compressed document could not be written: {error}"))?;

    Ok((!operation.is_cancelled()).then_some((rewritten, compressed)))
}

impl PdfiumEngine {
    /// The dialog's bottom line. The lossless figure is the pipeline's own
    /// output — exact — while a rasterized one extrapolates sampled pages.
    /// `None` reports the run was stopped, which a superseding estimate or a
    /// closing dialog asks for; the answer it abandons was already unwanted.
    pub(in crate::pdfium) fn estimate_compression(
        &self,
        document_id: u64,
        options: CompressionOptions,
    ) -> Result<Option<CompressionEstimate>, String> {
        let operation = self.begin_operation(OperationTarget::Compress(document_id));
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        match options {
            CompressionOptions::Lossless => {
                let Some((rewritten, compressed)) = lossless_output(&entry.document, &operation)?
                else {
                    return Ok(None);
                };

                // The rewrite this branch needs anyway is the baseline a
                // later rasterized estimate reads instead of its own.
                entry.serialized_len = Some(rewritten.len() as u64);

                Ok(Some(CompressionEstimate::new(
                    rewritten.len() as u64,
                    compressed.len() as u64,
                    true,
                )))
            }
            CompressionOptions::Rasterized { .. } => {
                let levels = raster_levels(options)?;
                let pages = entry.document.pages().len() as usize;
                // The baseline belongs to the document, not the levels, so it
                // is memoized: every slider settle re-asks, and serializing
                // the whole document each time is what the sampled pages
                // exist to spare. Any content change retires it.
                let original = match entry.serialized_len {
                    Some(original) => original,
                    None => {
                        let original = entry
                            .document
                            .save_to_bytes()
                            .map_err(|error| {
                                format!("PDFium could not rewrite the document: {error}")
                            })?
                            .len() as u64;
                        entry.serialized_len = Some(original);
                        original
                    }
                };

                let mut sampled = 0u64;
                for step in 0..pages.min(ESTIMATE_SAMPLE_PAGES) {
                    // Between pages, as every loop under this lock must.
                    if operation.is_cancelled() {
                        return Ok(None);
                    }

                    let index = sampled_page_index(step, pages);
                    let page = entry.document.pages().get(index).map_err(|error| {
                        format!("PDFium could not load page {}: {error}", index + 1)
                    })?;
                    sampled += page_jpeg(&page, index as usize, &levels)?.len() as u64;
                }

                // A document always has its first page to speak for it, so a
                // one-page sample divides by one, never by zero.
                let samples = pages.clamp(1, ESTIMATE_SAMPLE_PAGES) as u64;
                let estimated =
                    sampled / samples * pages as u64 + ESTIMATE_PAGE_OVERHEAD * pages as u64;

                Ok(Some(CompressionEstimate::new(original, estimated, false)))
            }
        }
    }

    /// A compressed copy for a reader-chosen destination, announced per page
    /// where pages are what the work is. `false` abandons, leaving no file.
    pub(in crate::pdfium) fn export_compressed(
        &self,
        document_id: u64,
        path: &Path,
        options: CompressionOptions,
        on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let operation = self.begin_operation(OperationTarget::Compress(document_id));
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;

        // Like an archive, a compressed copy is a different file by
        // construction: it cannot replace any open PDF, its own source
        // included, whose edit history it would silently stop describing.
        if documents.values().any(|document| {
            document
                .source_path
                .as_deref()
                .is_some_and(|source| io::same_file(source, path))
        }) {
            return Err("a compressed copy cannot replace an open PDF".into());
        }

        match options {
            CompressionOptions::Lossless => {
                // Each stage is one whole document long; the stops are read
                // between them inside `lossless_output`.
                let Some((_, compressed)) = lossless_output(&entry.document, &operation)? else {
                    return Ok(false);
                };

                io::write_file_atomically(path, |file| {
                    file.write_all(&compressed)
                        .map_err(|error| {
                            format!("could not write the compressed document: {error}")
                        })
                        .map(|()| true)
                })
            }
            CompressionOptions::Rasterized { .. } => {
                let levels = raster_levels(options)?;
                // A stop mid-run abandons like every export: no file, no error
                // — the reader asked for it, which is not a failure.
                let Some(bytes) =
                    self.rasterized_bytes(&entry.document, &operation, &levels, on_progress)?
                else {
                    return Ok(false);
                };

                io::write_file_atomically(path, |file| {
                    file.write_all(&bytes)
                        .map_err(|error| format!("could not write the image PDF: {error}"))
                        .map(|()| true)
                })
            }
        }
    }
}
