//! A copy of a document with every page fitted onto A4, which the reader's tab
//! then shows as the file it was saved to.

use super::archive_export::section_outline;
use super::io::{append_page_fitted_to_a4, MergeDraft, EXPORT_DOCUMENT_CHANGED_ERROR};
use super::*;

/// An A4 copy as `fit_to_a4` opens it.
#[derive(Debug)]
pub struct A4Copy {
    pub document: PdfDocumentInfo,
    /// This session's watermark or page numbers could not be lifted off the
    /// pages, so they were fitted along with them, at each page's own scale.
    pub layers_scaled: bool,
}

impl PdfiumEngine {
    /// Every page fitted onto A4 in order — never enlarged, laid on its side
    /// where that shrinks it less — with a blank A4 sheet where a Save As puts
    /// one between files, and the bookmarks a Save As writes. A page's
    /// annotations, links and fields stay behind: the sheet takes a form of
    /// its content alone. This session's watermark and page numbers are lifted
    /// first and stamped again on the sheets, as their own content. Opened as
    /// a document of its own for the caller to write and bind; `None` once
    /// stopped, which the closing of the document also does. Progress counts
    /// each page fitted, then each stamping pass over it.
    pub fn fit_to_a4(
        &self,
        document_id: u64,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<Option<A4Copy>, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut draft = MergeDraft::new(self)?;
        let (version, flatten, sheets, nodes, named, total, layers, mut layered) = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;
            // A new file cannot keep the signatures; drawn in first, if asked.
            let flatten = entry.output_flattens()?;
            let (padding, nodes) = entry.save_as_layout().unwrap_or_else(|| {
                let own = collect_bookmark_siblings(entry.document.bookmarks().root());

                (
                    Vec::new(),
                    section_outline(&own, 0, entry.page_ids.len() as i32),
                )
            });

            // Each blank turned as the sheet of the page it backs.
            let sheets: Vec<_> = padding
                .iter()
                .map(|after| {
                    let shown = entry
                        .page_geometry
                        .get(&entry.page_ids[*after])
                        .copied()
                        .unwrap_or(UNMEASURED_PAGE);
                    let sheet = a4_placement(shown.width, shown.height);

                    (*after, sheet.sheet_width, sheet.sheet_height)
                })
                .collect();
            // Taken before the copy, the last thing here that can fail: once
            // made, the copy closes by taking the lock this block holds.
            let layers = (
                self.existing_watermark(entry)?,
                self.existing_page_numbers(entry)?,
            );
            let layered = self
                .layered_copy(entry, &operation)?
                .map(|(copy, owned)| (MergeDraft::holding(self, copy), owned));

            (
                entry.content_version,
                flatten,
                sheets,
                nodes,
                entry.source_path.clone().unwrap_or_default(),
                entry.page_ids.len(),
                layers,
                layered,
            )
        };
        // Lifted layers are stamped again; ones that could not be go along.
        let layers_scaled = layered.is_none() && (layers.0.is_some() || layers.1.is_some());
        let (watermark, page_numbers) = if layered.is_some() {
            layers
        } else {
            (None, None)
        };
        // A stamping makes two passes over the pages: planned, then laid.
        let stamped_steps = if watermark.is_some() || page_numbers.is_some() {
            total * 2
        } else {
            0
        };
        let steps = total + stamped_steps;

        for index in 0..total {
            if operation.is_cancelled() {
                return Ok(None);
            }

            // Page by page, so a render elsewhere waits for one page, not all.
            {
                let documents = self.lock_documents()?;
                let entry = open_entry(&documents, document_id)?;

                if entry.content_version != version {
                    return Err(EXPORT_DOCUMENT_CHANGED_ERROR.into());
                }

                let fitted = draft.document();
                let at = index as PdfPageIndex;
                let source = match layered.as_mut() {
                    Some((copy, owned)) => {
                        let copy = copy.document();

                        Self::lift_owned_tail(copy, index, owned[index])?;
                        &*copy
                    }
                    None => &entry.document,
                };

                if flatten && signatures::has_widgets(source, at)? {
                    let page = signatures::flattened_pages(self.pdfium, source, &[index])?;

                    append_page_fitted_to_a4(fitted, &page, 0, &named)?;
                } else {
                    append_page_fitted_to_a4(fitted, source, at, &named)?;
                }
            }

            on_progress(index + 1, steps);
        }

        let bytes = {
            let _documents = self.lock_documents()?;
            let bytes = draft
                .document()
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not write the A4 document: {error}"))?;

            draft.close();

            if let Some((copy, _)) = layered.as_mut() {
                copy.close();
            }

            bytes
        };
        // Laid out for the A4 sheets, as a layer applied to them would be, and
        // before the blanks go in: a Save As leaves those bare, neither numbered
        // nor counted.
        let bytes = if watermark.is_some() || page_numbers.is_some() {
            let plain = self.open_with_source(bytes, None)?;
            // Scaled onto those steps, so the bar ends full whatever it counts.
            let mut on_stamped = |done: usize, of: usize| {
                on_progress(total + done * stamped_steps / of.max(1), steps)
            };
            let stamped = self
                .stamp_layers(
                    plain.id,
                    watermark,
                    page_numbers,
                    &mut on_stamped,
                    &operation,
                )
                .and_then(|landed| {
                    if !landed {
                        return Ok(None);
                    }

                    let documents = self.lock_documents()?;

                    open_entry(&documents, plain.id)?
                        .document
                        .save_to_bytes()
                        .map(Some)
                        .map_err(|error| format!("PDFium could not write the A4 document: {error}"))
                });

            self.close(plain.id).ok();

            match stamped? {
                Some(bytes) => bytes,
                None => return Ok(None),
            }
        } else {
            bytes
        };
        let bytes = {
            let _documents = self.lock_documents()?;

            self.with_blank_pages(bytes, &sheets)?
        };
        // Byte work, off the lock: the sheets are new page objects, so the
        // bookmarks are written afresh rather than carried.
        let bytes = outline::write_outline(bytes, &nodes)?;

        if operation.is_cancelled() {
            return Ok(None);
        }

        self.open_with_source(bytes, None).map(|document| {
            Some(A4Copy {
                document,
                layers_scaled,
            })
        })
    }
}
