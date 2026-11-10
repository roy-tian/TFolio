//! A copy of a document with every page fitted onto A4, which the reader's tab
//! then shows as the file it was saved to.

use super::archive_export::section_outline;
use super::io::{append_page_fitted_to_a4, MergeDraft};
use super::*;

impl PdfiumEngine {
    /// Every page fitted onto A4 in order — never enlarged, laid on its side
    /// where that shrinks it less — with a blank A4 sheet where a Save As puts
    /// one between files, and the bookmarks a Save As writes. A page's
    /// annotations, links and fields stay behind: the sheet takes a form of
    /// its content alone, a watermark or page numbers with it. Opened as a
    /// document of its own for the caller to write and bind; `None` once
    /// stopped, which the closing of the document also does.
    pub fn fit_to_a4(
        &self,
        document_id: u64,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<Option<PdfDocumentInfo>, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut draft = MergeDraft::new(self)?;
        let (version, flatten, padding, nodes, named, total) = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;
            // A new file cannot keep the signatures; drawn in first, if asked.
            let flatten = entry.output_flattens()?;
            let combined = entry.sections.as_ref().filter(|_| entry.combined());
            let padding = combined
                .map(|book| book.padding(&entry.page_ids))
                .unwrap_or_default();
            let nodes = match combined {
                Some(book) => book.outline(&entry.page_ids, &padding),
                None => section_outline(
                    &collect_bookmark_siblings(entry.document.bookmarks().root()),
                    0,
                    entry.page_ids.len() as i32,
                ),
            };

            (
                entry.content_version,
                flatten,
                padding,
                nodes,
                entry.source_path.clone().unwrap_or_default(),
                entry.page_ids.len(),
            )
        };

        for index in 0..total {
            if operation.is_cancelled() {
                return Ok(None);
            }

            // Page by page, so a render elsewhere waits for one page, not all.
            {
                let documents = self.lock_documents()?;
                let entry = open_entry(&documents, document_id)?;

                if entry.content_version != version {
                    return Err("the document changed while it was fitted onto A4".into());
                }

                let fitted = draft.document();
                let at = index as PdfPageIndex;

                if flatten && signatures::has_widgets(&entry.document, at)? {
                    let page = signatures::flattened_pages(self.pdfium, &entry.document, &[index])?;

                    append_page_fitted_to_a4(fitted, &page, 0, &named)?;
                } else {
                    append_page_fitted_to_a4(fitted, &entry.document, at, &named)?;
                }

                if padding.contains(&index) {
                    // The back of the page's leaf: turned as its sheet is.
                    let shown = entry
                        .page_geometry
                        .get(&entry.page_ids[index])
                        .copied()
                        .unwrap_or(UNMEASURED_PAGE);
                    let sheet = a4_placement(shown.width, shown.height);

                    fitted
                        .pages_mut()
                        .create_page_at_end(PdfPagePaperSize::Custom(
                            PdfPoints::new(sheet.sheet_width),
                            PdfPoints::new(sheet.sheet_height),
                        ))
                        .map_err(|error| format!("PDFium could not add a blank page: {error}"))?;
                }
            }

            on_progress(index + 1, total);
        }

        let bytes = {
            let _documents = self.lock_documents()?;
            let bytes = draft
                .document()
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not write the A4 document: {error}"))?;

            draft.close();
            bytes
        };
        // Byte work, off the lock: the sheets are new page objects, so the
        // bookmarks are written afresh rather than carried.
        let bytes = outline::write_outline(bytes, &nodes)?;

        if operation.is_cancelled() {
            return Ok(None);
        }

        self.open_with_source(bytes, None).map(Some)
    }
}
