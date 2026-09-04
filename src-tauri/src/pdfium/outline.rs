//! Writing a document outline — the one PDF edit PDFium cannot make.
//!
//! PDFium's public API reads bookmarks (`FPDFBookmark_*`) and has no call that
//! creates one, and `FPDF_ImportPages`, which every merge goes through, leaves
//! the source's outline behind. So the merged document's bytes, once PDFium has
//! saved them, are reopened here with a pure-Rust parser long enough to have an
//! `/Outlines` tree written into them.
//!
//! What reaches this module is only ever bytes PDFium produced moments earlier
//! in this process: a reader's own file is still parsed by PDFium alone, which
//! is what keeps the second parser off the untrusted path.

use lopdf::{Bookmark, Document, Object};

/// One entry of the outline to write, in the tree shape it will take. `page`
/// is a 0-based index into the merged document; an index past the last page is
/// pulled back to the last one, since a bookmark must point somewhere.
pub(super) struct OutlineNode {
    pub(super) title: String,
    pub(super) page: usize,
    pub(super) children: Vec<OutlineNode>,
}

/// A bookmark title long enough to be a payload rather than a name. Source
/// titles are a merged file's own text, so they are cut rather than trusted.
const MAX_TITLE_CHARS: usize = 512;

/// Writes `nodes` as `bytes`' outline, giving back the rewritten document.
/// An empty `nodes` gives the bytes back untouched — a document with no
/// bookmarks is the shape PDFium already produced, so there is nothing to do.
pub(super) fn write_outline(bytes: Vec<u8>, nodes: &[OutlineNode]) -> Result<Vec<u8>, String> {
    if nodes.is_empty() {
        return Ok(bytes);
    }

    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the merged document could not be reread: {error}"))?;
    // 1-based page number to object id, which is what a bookmark's destination
    // is expressed in. Collected once: the map is the whole page tree walked.
    let pages: Vec<_> = document.get_pages().into_values().collect();

    if pages.is_empty() {
        return Err("the merged document has no pages to bookmark".into());
    }

    add_nodes(&mut document, &pages, nodes, None);

    let Some(outline_id) = document.build_outline() else {
        return Ok(bytes);
    };

    document
        .catalog_mut()
        .map_err(|error| format!("the merged document has no catalogue: {error}"))?
        .set("Outlines", Object::Reference(outline_id));

    let mut written = Vec::with_capacity(bytes.len());

    document
        .save_to(&mut written)
        .map_err(|error| format!("the outline could not be written: {error}"))?;

    Ok(written)
}

fn add_nodes(
    document: &mut Document,
    pages: &[lopdf::ObjectId],
    nodes: &[OutlineNode],
    parent: Option<u32>,
) {
    for node in nodes {
        let page = pages[node.page.min(pages.len() - 1)];
        let title: String = node.title.chars().take(MAX_TITLE_CHARS).collect();
        // Black, upright: the look a viewer gives a bookmark that says nothing
        // about how it should be drawn.
        let id = document.add_bookmark(Bookmark::new(title, [0.0, 0.0, 0.0], 0, page), parent);

        add_nodes(document, pages, &node.children, Some(id));
    }
}
