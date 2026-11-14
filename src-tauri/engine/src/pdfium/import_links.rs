//! What a page copy keeps aimed at the document it came from: FPDF_ImportPages
//! never rewrites a reference under `/Parent`, `/Prev` or `/First` (a pop-up's
//! link to its markup, a widget's to its field), so in its fresh output those
//! name objects by the source's numbers. lopdf drops them where they no longer
//! name anything; only a pop-up or a widget carries one in a real file.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};
use pdfium_render::prelude::*;

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

/// The annotations with an unrewritten link that a document's pages may
/// carry: found as its pages are measured, widened by every import, never
/// narrowed, so a page deleted since still counts. A `/Parent` elsewhere on a
/// page goes unseen and comes along; the `reread` keeps it from crashing.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LinkedAnnotations {
    /// A pop-up naming its markup, or a markup naming a pop-up, which may
    /// name it back from outside `/Annots`.
    popups: bool,
    /// Another annotation naming a `/Parent`: a widget its field, mostly.
    widgets: bool,
}

impl LinkedAnnotations {
    /// By the keys themselves, which pdfium-render's annotation types hide:
    /// a widget may lack its `/Subtype`, a pop-up be missing from `/Annots`.
    pub(super) fn of(page: &PdfPage<'_>) -> Self {
        let bindings = page.bindings();
        let handle = bindings.get_handle_from_page(page);
        let popup = PdfPageAnnotationType::Popup as FPDF_ANNOTATION_SUBTYPE;
        let mut found = Self::default();

        // SAFETY: the page stays loaded for this borrow, each annotation is
        // closed before the next is taken, and the engine serializes PDFium.
        unsafe {
            for index in 0..bindings.FPDFPage_GetAnnotCount(handle) {
                let annotation = bindings.FPDFPage_GetAnnot(handle, index);

                if annotation.is_null() {
                    continue;
                }

                let is_popup = bindings.FPDFAnnot_GetSubtype(annotation) == popup;
                let parent = bindings.is_true(bindings.FPDFAnnot_HasKey(annotation, "Parent"));
                let names_popup = bindings.is_true(bindings.FPDFAnnot_HasKey(annotation, "Popup"));

                bindings.FPDFPage_CloseAnnot(annotation);
                found.popups |= names_popup || (is_popup && parent);
                found.widgets |= parent && !is_popup;
            }
        }

        found
    }

    pub(super) fn with(self, other: Self) -> Self {
        Self {
            popups: self.popups || other.popups,
            widgets: self.widgets || other.widgets,
        }
    }

    /// Whether a copy headed `headed` has links of these to drop: a pop-up's
    /// anywhere, a widget's only away from its document.
    pub(super) fn dead_links(self, headed: Headed) -> bool {
        match headed {
            Headed::Home => self.popups,
            Headed::Away => self.popups || self.widgets,
        }
    }
}

/// `bytes`, PDFium's fresh output of copied pages, as `drop_unrewritten_links`
/// leaves them.
pub(super) fn without_unrewritten_links(bytes: Vec<u8>, headed: Headed) -> Result<Vec<u8>, String> {
    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the copied pages could not be reread: {error}"))?;

    if !drop_unrewritten_links(&mut document, headed) {
        return Ok(bytes);
    }

    let mut written = Vec::with_capacity(bytes.len());

    document
        .save_to(&mut written)
        .map_err(|error| format!("the copied pages could not be written: {error}"))?;
    Ok(written)
}

/// Drops the `/Parent`, `/Prev` and `/First` references reachable from a page
/// that `headed` says no longer name anything; a page's own `/Parent`, the
/// copy's page tree, always stays. A pop-up keeps its markup's `/Popup` link
/// to it and loses only the optional way back. `true` if any went.
pub(super) fn drop_unrewritten_links(document: &mut Document, headed: Headed) -> bool {
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

    dropped
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
