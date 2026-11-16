//! FPDF_ImportPages leaves parts of its copy aimed into the document it
//! copied from: whatever sits under `/Parent`, `/Prev` or `/First`
//! (`import_links`), and an indirect array it gave up on half-copied (a
//! destination on a page not yet copied), which a second reference to the
//! same array then reuses. They point into that document's memory, so once it
//! closes the copy's next save follows them there and PDFium crashes. So a
//! document that took pages is read back from its own bytes (`reread`) while
//! what it took them from is still open, and a copy that must outlive its
//! source, or would bring dead links along, is detached first. A half-copied
//! destination then names whatever its old number names in the new document,
//! as PDFium had already dropped the reference that gave up on it.

use super::page_ops::page_range_argument;
use super::*;

/// Pages `indices` (0-based, ascending) of `source` imported into a new
/// document, still aimed into `source`: read only while it is open.
pub(super) fn copied_pages(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
) -> Result<PdfDocument<'static>, String> {
    let mut copy = pdfium
        .create_new_pdf()
        .map_err(|error| format!("PDFium could not create a document: {error}"))?;

    copy.pages_mut()
        .copy_pages_from_document(source, &page_range_argument(indices), 0)
        .map_err(|error| format!("PDFium could not copy the pages: {error}"))?;

    let copied = copy.pages().len() as usize;

    if copied != indices.len() {
        return Err(format!(
            "PDFium copied {copied} pages where {} were asked for",
            indices.len()
        ));
    }

    Ok(copy)
}

/// `copied_pages` as bytes that hold nothing of `source`, without the links
/// `linked` says a copy headed `headed` must drop.
pub(super) fn detached_bytes(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
    headed: Headed,
    linked: LinkedAnnotations,
) -> Result<Vec<u8>, String> {
    // A new document's save follows no reference, so what is aimed into
    // `source` comes out as the number it holds there.
    let bytes = copied_pages(pdfium, source, indices)?
        .save_to_bytes()
        .map_err(|error| format!("PDFium could not write the copied pages: {error}"))?;

    if linked.dead_links(headed) {
        without_unrewritten_links(bytes, headed)
    } else {
        Ok(bytes)
    }
}

/// `detached_bytes` read back: a document an import can take pages from.
pub(super) fn detached_pages(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
    headed: Headed,
    linked: LinkedAnnotations,
) -> Result<PdfDocument<'static>, String> {
    pdfium
        .load_pdf_from_byte_vec(
            detached_bytes(pdfium, source, indices, headed, linked)?,
            None,
        )
        .map_err(|error| format!("PDFium could not read the copied pages back: {error}"))
}

/// What pages `indices` of `source` go into another document from: a copy
/// where their signatures must be drawn in or their links would come along
/// dead, else `None`, `source` itself, which must outlive the `reread`.
pub(super) fn lent_copy(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
    flatten: bool,
    linked: LinkedAnnotations,
) -> Result<Option<PdfDocument<'static>>, String> {
    if flatten {
        signatures::flattened_pages(pdfium, source, indices, linked).map(Some)
    } else if linked.dead_links(Headed::Away) {
        detached_pages(pdfium, source, indices, Headed::Away, linked).map(Some)
    } else {
        Ok(None)
    }
}

/// The document as an import found it, put back whole if the pages cannot
/// all go in or do not survive being read back: the bytes, and every
/// page-keyed record an import touches.
pub(super) struct ImportRollback {
    snapshot: Vec<u8>,
    page_ids: Vec<u64>,
    owned_content: Option<OwnedContentState>,
    merged_page_ids: HashSet<u64>,
    foreign_page_ids: HashSet<u64>,
    linked: LinkedAnnotations,
    /// No files yet: an import that begins them takes them away again.
    no_sections: bool,
}

impl ImportRollback {
    pub(super) fn of(entry: &OpenDocument) -> Result<Self, String> {
        Ok(Self {
            snapshot: entry
                .document
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?,
            page_ids: entry.page_ids.clone(),
            owned_content: entry.owned_content.clone(),
            merged_page_ids: entry.merged_page_ids.clone(),
            foreign_page_ids: entry.foreign_page_ids.clone(),
            linked: entry.linked,
            no_sections: entry.sections.is_none(),
        })
    }

    pub(super) fn roll_back(
        self,
        engine: &PdfiumEngine,
        entry: &mut OpenDocument,
        cause: String,
    ) -> String {
        entry.page_ids = self.page_ids;
        entry.owned_content = self.owned_content;
        entry.merged_page_ids = self.merged_page_ids;
        entry.foreign_page_ids = self.foreign_page_ids;
        entry.linked = self.linked;

        if self.no_sections {
            entry.sections = None;
        }

        engine.restore_document_snapshot(entry, self.snapshot, cause)
    }
}

impl PdfiumEngine {
    /// `document` read back from its own bytes, which keep of each reference
    /// only the number it names, once every owned layer's tail is proved to
    /// have come through on the pages `page_ids` and `owned` describe. Due
    /// after every import, while the document the pages came from is still
    /// open: the save follows what the import left aimed there.
    pub(super) fn reread_pages(
        &self,
        document: &PdfDocument<'static>,
        page_ids: &[u64],
        owned: Option<&OwnedContentState>,
    ) -> Result<PdfDocument<'static>, String> {
        let bytes = document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;
        let reread = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reread the document: {error}"))?;

        if let Some(state) = owned {
            // No Stop to offer: checked in one pass.
            Self::verify_owned_tail(&reread, page_ids, state, None, &mut |_, _| {}).map_err(
                |error| format!("PDFium did not keep this session's layers reading back: {error}"),
            )?;
        }

        Ok(reread)
    }

    /// `reread_pages` for a document whose records already name every page.
    /// Every object is then the read-back file's, which a save writes only if
    /// something references it: nothing is left for `collect_orphans`.
    pub(super) fn reread(&self, entry: &mut OpenDocument) -> Result<(), String> {
        entry.document = self.reread_pages(
            &entry.document,
            &entry.page_ids,
            entry.owned_content.as_ref(),
        )?;
        entry.needs_compaction = false;

        Ok(())
    }
}
