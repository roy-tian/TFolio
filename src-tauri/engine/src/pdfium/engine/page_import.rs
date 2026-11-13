//! FPDF_ImportPages leaves parts of its copy aimed into the document it
//! copied from: whatever sits under `/Parent`, `/Prev` or `/First` (a pop-up's
//! link to its markup, a widget's to its field), which it never rewrites, and
//! an indirect array it gave up on half-copied (a destination on a page not
//! yet copied), which a second reference to the same array then reuses. They
//! point into that document's memory, so once it closes the copy's next save
//! follows them there and PDFium crashes. Pages therefore cross between
//! documents as a `detached_pages` copy, and a document that took some is read
//! back from its own bytes (`reread`) before that copy closes. A half-copied
//! destination then names whatever its old number names in the new document,
//! as PDFium had already dropped the reference that gave up on it.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};

use super::page_ops::page_range_argument;
use super::*;

/// The keys whose references FPDF_ImportPages copies as they are.
const UNREWRITTEN_KEYS: [&[u8]; 3] = [b"Parent", b"Prev", b"First"];

/// Where copied pages are headed, which decides what their unrewritten links
/// still name there.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Headed {
    /// Back into the document they came from, as an undo's stash or a paste:
    /// PDFium keeps its object numbers through a save, so a widget's link
    /// still names its field. Only a pop-up's goes, naming the original's
    /// markup rather than its copy's.
    Home,
    /// Into another document, where those numbers name nothing of theirs.
    Away,
}

/// Pages `indices` (0-based, ascending) of `source`, alone in new bytes that
/// hold nothing of it, the links PDFium left aimed at it dropped as `headed`
/// decides.
pub(super) fn detached_bytes(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
    headed: Headed,
) -> Result<Vec<u8>, String> {
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

    // A new document's save follows no reference, so what is aimed into
    // `source` comes out as the number it holds there.
    let bytes = copy
        .save_to_bytes()
        .map_err(|error| format!("PDFium could not write the copied pages: {error}"))?;

    without_unrewritten_links(bytes, headed)
}

/// `detached_bytes` read back: a document an import can take pages from.
pub(super) fn detached_pages(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
    headed: Headed,
) -> Result<PdfDocument<'static>, String> {
    pdfium
        .load_pdf_from_byte_vec(detached_bytes(pdfium, source, indices, headed)?, None)
        .map_err(|error| format!("PDFium could not read the copied pages back: {error}"))
}

/// `bytes`, PDFium's fresh output of copied pages, without the `/Parent`,
/// `/Prev` and `/First` references reachable from a page that `headed` says
/// no longer name anything; a page's own `/Parent`, the copy's page tree,
/// always stays. A pop-up keeps its markup's `/Popup` link to it and loses
/// only the optional way back.
pub(super) fn without_unrewritten_links(bytes: Vec<u8>, headed: Headed) -> Result<Vec<u8>, String> {
    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the copied pages could not be reread: {error}"))?;
    let pages: HashSet<ObjectId> = document.get_pages().into_values().collect();
    let mut pending: Vec<ObjectId> = pages.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut dropped = false;

    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }

        let Ok(object) = document.get_object_mut(id) else {
            continue;
        };

        dropped |= match object {
            Object::Dictionary(dict) => drop_links(dict, pages.contains(&id), headed, &mut pending),
            object => drop_links_within(object, headed, &mut pending),
        };
    }

    if !dropped {
        return Ok(bytes);
    }

    let mut written = Vec::with_capacity(bytes.len());

    document
        .save_to(&mut written)
        .map_err(|error| format!("the copied pages could not be written: {error}"))?;
    Ok(written)
}

/// Drops `dict`'s dead references and those of every direct object in it,
/// queueing the indirect objects it reaches; nothing past a page's `/Parent`
/// is walked.
fn drop_links(
    dict: &mut Dictionary,
    page: bool,
    headed: Headed,
    pending: &mut Vec<ObjectId>,
) -> bool {
    let popup = dict
        .get(b"Subtype")
        .and_then(Object::as_name)
        .is_ok_and(|subtype| subtype == b"Popup");
    let mut dropped = false;

    for key in UNREWRITTEN_KEYS {
        let dead = match headed {
            Headed::Home => popup && key == b"Parent",
            Headed::Away => !(page && key == b"Parent"),
        };

        if dead && dict.get(key).is_ok_and(holds_reference) {
            dict.remove(key);
            dropped = true;
        }
    }

    for (key, value) in dict.iter_mut() {
        if !(page && key.as_slice() == b"Parent") {
            dropped |= drop_links_within(value, headed, pending);
        }
    }

    dropped
}

fn drop_links_within(object: &mut Object, headed: Headed, pending: &mut Vec<ObjectId>) -> bool {
    match object {
        Object::Reference(id) => {
            pending.push(*id);
            false
        }
        Object::Array(items) => items.iter_mut().fold(false, |dropped, item| {
            drop_links_within(item, headed, pending) | dropped
        }),
        Object::Dictionary(dict) => drop_links(dict, false, headed, pending),
        Object::Stream(stream) => drop_links(&mut stream.dict, false, headed, pending),
        _ => false,
    }
}

fn holds_reference(object: &Object) -> bool {
    match object {
        Object::Reference(_) => true,
        Object::Array(items) => items.iter().any(holds_reference),
        Object::Dictionary(dict) => dict.iter().any(|(_, value)| holds_reference(value)),
        _ => false,
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
