//! PDFium's API reads bookmarks but cannot create or retarget one, so its
//! fresh output is reopened with lopdf — never a reader's file as opened.

use std::collections::{HashMap, HashSet};

use lopdf::{Bookmark, Dictionary, Document, Object, ObjectId};

/// `page` is 0-based; an index past the last page is pulled back to it, since
/// a bookmark must point somewhere.
pub(super) struct OutlineNode {
    pub(super) title: String,
    pub(super) page: usize,
    pub(super) children: Vec<OutlineNode>,
}

/// A bookmark title long enough to be a payload rather than a name. Source
/// titles are a merged file's own text, so they are cut rather than trusted.
const MAX_TITLE_CHARS: usize = 512;

/// An empty `nodes` gives the bytes back untouched: no bookmarks is the shape
/// PDFium already produced.
pub(super) fn write_outline(bytes: Vec<u8>, nodes: &[OutlineNode]) -> Result<Vec<u8>, String> {
    if nodes.is_empty() {
        return Ok(bytes);
    }

    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the merged document could not be reread: {error}"))?;
    install_outline(&mut document, nodes)?;

    let mut written = Vec::with_capacity(bytes.len());
    document
        .save_to(&mut written)
        .map_err(|error| format!("the outline could not be written: {error}"))?;
    Ok(written)
}

pub(super) fn install_outline(
    document: &mut Document,
    nodes: &[OutlineNode],
) -> Result<(), String> {
    if nodes.is_empty() {
        return Ok(());
    }
    // 1-based page number to object id, which is what a bookmark's destination
    // is expressed in. Collected once: the map is the whole page tree walked.
    let pages: Vec<_> = document.get_pages().into_values().collect();

    if pages.is_empty() {
        return Err("the merged document has no pages to bookmark".into());
    }

    add_nodes(document, &pages, nodes, None);

    let Some(outline_id) = document.build_outline() else {
        return Ok(());
    };

    document
        .catalog_mut()
        .map_err(|error| format!("the merged document has no catalogue: {error}"))?
        .set("Outlines", Object::Reference(outline_id));

    Ok(())
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

// Deeper than any real name tree; a cycle in a damaged one must still end.
const MAX_NAME_TREE_DEPTH: usize = 32;

/// A bookmark by its place in the tree — child indices from the top level —
/// and the 0-based page that now stands where its target was deleted from.
#[derive(Clone)]
pub(super) struct Relink {
    pub(super) path: Vec<usize>,
    pub(super) page: usize,
}

/// A restored page is a copy, so what pointed at the deleted page still names
/// the old object. Every reference to it is moved to the copy — the bookmark,
/// and any link or named destination sharing that target. `None` when nothing
/// needed it, or the document is encrypted and lopdf's rewrite can't be trusted.
pub(super) fn relink_pages(bytes: &[u8], relinks: &[Relink]) -> Result<Option<Vec<u8>>, String> {
    let mut document = Document::load_mem(bytes)
        .map_err(|error| format!("the document could not be reread: {error}"))?;

    if document.was_encrypted() || document.is_encrypted() {
        return Ok(None);
    }

    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    let live: HashSet<ObjectId> = pages.iter().copied().collect();
    let mut moved = HashMap::new();

    for relink in relinks {
        let (Some(old), Some(&new)) = (
            bookmark_at(&document, &relink.path).and_then(|item| destination_page(&document, item)),
            pages.get(relink.page),
        ) else {
            continue;
        };

        // A target still in the page tree resolves already; leave it be.
        if !live.contains(&old) {
            moved.entry(old).or_insert(new);
        }
    }

    if moved.is_empty() {
        return Ok(None);
    }

    for (id, object) in document.objects.iter_mut() {
        // The old page itself goes unreferenced; its own links can stay.
        if !moved.contains_key(id) {
            replace_references(object, &moved);
        }
    }

    let mut written = Vec::with_capacity(bytes.len());
    document
        .save_to(&mut written)
        .map_err(|error| format!("the relinked document could not be written: {error}"))?;
    Ok(Some(written))
}

fn bookmark_at<'a>(document: &'a Document, path: &[usize]) -> Option<&'a Dictionary> {
    let outlines = document.catalog().ok()?.get(b"Outlines").ok()?;
    let mut parent = document.dereference(outlines).ok()?.1.as_dict().ok()?;

    for &index in path {
        let mut id = parent.get(b"First").ok()?.as_reference().ok()?;

        for _ in 0..index {
            id = document
                .get_dictionary(id)
                .ok()?
                .get(b"Next")
                .ok()?
                .as_reference()
                .ok()?;
        }

        parent = document.get_dictionary(id).ok()?;
    }

    (!path.is_empty()).then_some(parent)
}

/// The page object a bookmark's destination names, explicitly, through a GoTo
/// action, or by a named destination.
fn destination_page(document: &Document, item: &Dictionary) -> Option<ObjectId> {
    let destination = match item.get(b"Dest") {
        Ok(destination) => destination,
        Err(_) => {
            let action = document
                .dereference(item.get(b"A").ok()?)
                .ok()?
                .1
                .as_dict()
                .ok()?;

            if action.get(b"S").ok()?.as_name().ok()? != b"GoTo" {
                return None;
            }

            action.get(b"D").ok()?
        }
    };

    explicit_page(document, destination)
        .or_else(|| explicit_page(document, named_destination(document, destination)?))
}

fn explicit_page(document: &Document, destination: &Object) -> Option<ObjectId> {
    let resolved = document.dereference(destination).ok()?.1;
    // A named destination's value may be the array or a dictionary holding it.
    let array = match resolved {
        Object::Dictionary(dictionary) => document
            .dereference(dictionary.get(b"D").ok()?)
            .ok()?
            .1
            .as_array()
            .ok()?,
        other => other.as_array().ok()?,
    };

    array.first()?.as_reference().ok()
}

fn named_destination<'a>(document: &'a Document, name: &Object) -> Option<&'a Object> {
    let key = match document.dereference(name).ok()?.1 {
        Object::Name(name) => name.as_slice(),
        Object::String(name, _) => name.as_slice(),
        _ => return None,
    };
    let catalog = document.catalog().ok()?;

    // PDF 1.1's flat dictionary, then the name tree that replaced it.
    if let Some(found) = catalog
        .get(b"Dests")
        .ok()
        .and_then(|dests| document.dereference(dests).ok()?.1.as_dict().ok())
        .and_then(|dests| dests.get(key).ok())
    {
        return Some(found);
    }

    let names = document
        .dereference(catalog.get(b"Names").ok()?)
        .ok()?
        .1
        .as_dict()
        .ok()?;
    let tree = document
        .dereference(names.get(b"Dests").ok()?)
        .ok()?
        .1
        .as_dict()
        .ok()?;

    find_in_name_tree(document, tree, key, 0)
}

fn find_in_name_tree<'a>(
    document: &'a Document,
    node: &'a Dictionary,
    key: &[u8],
    depth: usize,
) -> Option<&'a Object> {
    if depth > MAX_NAME_TREE_DEPTH {
        return None;
    }

    if let Some(pair) = node
        .get(b"Names")
        .and_then(Object::as_array)
        .ok()
        .and_then(|names| {
            names.as_chunks::<2>().0.iter().find(|pair| {
                document
                    .dereference(&pair[0])
                    .ok()
                    .and_then(|(_, name)| name.as_str().ok())
                    == Some(key)
            })
        })
    {
        return Some(&pair[1]);
    }

    node.get(b"Kids")
        .and_then(Object::as_array)
        .ok()?
        .iter()
        .filter_map(|kid| document.dereference(kid).ok()?.1.as_dict().ok())
        .find_map(|kid| find_in_name_tree(document, kid, key, depth + 1))
}

fn replace_references(object: &mut Object, moved: &HashMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => {
            if let Some(new) = moved.get(id) {
                *id = *new;
            }
        }
        Object::Array(items) => {
            for item in items {
                replace_references(item, moved);
            }
        }
        Object::Dictionary(dictionary) => {
            for (_, value) in dictionary.iter_mut() {
                replace_references(value, moved);
            }
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter_mut() {
                replace_references(value, moved);
            }
        }
        _ => {}
    }
}
