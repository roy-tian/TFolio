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
pub(super) const MAX_TITLE_CHARS: usize = 512;

/// An editable bookmark in a single-file document, tracking its original
/// child-index path in PDFium's `/Outlines` tree so `lopdf` can mutate only
/// its `/Title` and tree links while preserving destinations, actions, and styles.
#[derive(Clone, Debug)]
pub(super) struct EditableOutlineItem {
    pub(super) origin: Vec<usize>,
    pub(super) title: String,
    pub(super) children: Vec<EditableOutlineItem>,
}

fn check_title_length(title: &str) -> Result<(), String> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "a bookmark's name holds at most {MAX_TITLE_CHARS} characters"
        ));
    }

    Ok(())
}

/// Validates a reader-supplied bookmark title: trimmed, non-empty, and bounded.
pub(super) fn validate_title(title: &str) -> Result<String, String> {
    let title = title.trim();

    if title.is_empty() {
        return Err("a bookmark needs a name".into());
    }

    check_title_length(title)?;
    Ok(title.to_string())
}

/// Validates a saved pre-rename bookmark title restored by undo without trimming.
pub(super) fn validate_exact_title(title: &str) -> Result<String, String> {
    check_title_length(title)?;
    Ok(title.to_string())
}

fn encode_outline_title(title: &str) -> Object {
    let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
    let bytes = if title.is_ascii() {
        title.into_bytes()
    } else {
        let mut bom = vec![0xFE, 0xFF];
        bom.extend(title.encode_utf16().flat_map(u16::to_be_bytes));
        bom
    };

    Object::string_literal(bytes)
}

/// Replaces `/Outlines` when `nodes` is non-empty, or removes any existing
/// `/Outlines` from the catalog when `nodes` is empty.
pub(super) fn replace_outline(bytes: Vec<u8>, nodes: &[OutlineNode]) -> Result<Vec<u8>, String> {
    if !nodes.is_empty() {
        return write_outline(bytes, nodes);
    }

    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the merged document could not be reread: {error}"))?;
    let has_outlines = document
        .catalog()
        .is_ok_and(|catalog| catalog.has(b"Outlines"));

    if !has_outlines {
        return Ok(bytes);
    }

    document
        .catalog_mut()
        .map_err(|error| format!("the merged document has no catalogue: {error}"))?
        .remove(b"Outlines");

    let mut written = Vec::with_capacity(bytes.len());
    document
        .save_to(&mut written)
        .map_err(|error| format!("the outline could not be removed: {error}"))?;
    Ok(written)
}

/// Applies title edits and deletions onto PDFium's fresh output, preserving
/// each surviving bookmark's destination, action, colour, and style flags.
pub(super) fn apply_outline_edits(
    bytes: Vec<u8>,
    items: &[EditableOutlineItem],
) -> Result<Vec<u8>, String> {
    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("the document could not be reread for its outline: {error}"))?;

    if document.was_encrypted() || document.is_encrypted() {
        return Err("cannot edit bookmarks of an encrypted document".into());
    }

    let outlines_ref = document
        .catalog()
        .map_err(|error| format!("the document has no catalogue: {error}"))?
        .get(b"Outlines")
        .ok()
        .cloned();

    let Some(outlines_obj) = outlines_ref else {
        return if items.is_empty() {
            Ok(bytes)
        } else {
            Err("the document has no outline to update".into())
        };
    };

    let outlines_id = match outlines_obj {
        Object::Reference(id) => id,
        Object::Dictionary(dict) => {
            let id = document.add_object(dict);
            document
                .catalog_mut()
                .map_err(|error| format!("the document has no catalogue: {error}"))?
                .set("Outlines", Object::Reference(id));
            id
        }
        _ => return Err("the document's outline is not a dictionary".into()),
    };

    let mut by_origin = HashMap::new();
    let mut all_ids = Vec::new();
    let mut closed = HashSet::new();
    let mut visited = HashSet::new();
    let mut path = Vec::new();
    collect_existing_outline(
        &document,
        outlines_id,
        &mut path,
        &mut visited,
        &mut by_origin,
        &mut all_ids,
        &mut closed,
    );

    if items.is_empty() {
        document
            .catalog_mut()
            .map_err(|error| format!("the document has no catalogue: {error}"))?
            .remove(b"Outlines");
        document.objects.remove(&outlines_id);
        for id in all_ids {
            document.objects.remove(&id);
        }
    } else {
        let mut kept = HashSet::new();
        let (first, last, count) = relink_outline_level(
            &mut document,
            outlines_id,
            items,
            &by_origin,
            &closed,
            &mut kept,
        )?;

        let root = document
            .get_dictionary_mut(outlines_id)
            .map_err(|error| format!("the document's outline root is invalid: {error}"))?;
        if let (Some(first), Some(last)) = (first, last) {
            root.set("First", Object::Reference(first));
            root.set("Last", Object::Reference(last));
            root.set("Count", Object::Integer(count));
        }

        for id in all_ids {
            if !kept.contains(&id) {
                document.objects.remove(&id);
            }
        }
    }

    let mut written = Vec::with_capacity(bytes.len());
    document
        .save_to(&mut written)
        .map_err(|error| format!("the edited outline could not be written: {error}"))?;
    Ok(written)
}

fn collect_existing_outline(
    document: &Document,
    parent_id: ObjectId,
    path: &mut Vec<usize>,
    visited: &mut HashSet<ObjectId>,
    by_origin: &mut HashMap<Vec<usize>, ObjectId>,
    all_ids: &mut Vec<ObjectId>,
    closed: &mut HashSet<ObjectId>,
) {
    let Ok(parent) = document.get_dictionary(parent_id) else {
        return;
    };
    let Ok(mut current) = parent.get(b"First").and_then(Object::as_reference) else {
        return;
    };
    let mut index = 0usize;

    while visited.insert(current) {
        let Ok(dict) = document.get_dictionary(current) else {
            break;
        };

        path.push(index);
        by_origin.insert(path.clone(), current);
        all_ids.push(current);

        if dict
            .get(b"Count")
            .and_then(Object::as_i64)
            .is_ok_and(|count| count < 0)
        {
            closed.insert(current);
        }

        collect_existing_outline(document, current, path, visited, by_origin, all_ids, closed);
        path.pop();

        let Ok(next) = dict.get(b"Next").and_then(Object::as_reference) else {
            break;
        };
        current = next;
        index += 1;
    }
}

fn relink_outline_level(
    document: &mut Document,
    parent_id: ObjectId,
    items: &[EditableOutlineItem],
    by_origin: &HashMap<Vec<usize>, ObjectId>,
    closed: &HashSet<ObjectId>,
    kept: &mut HashSet<ObjectId>,
) -> Result<(Option<ObjectId>, Option<ObjectId>, i64), String> {
    if items.is_empty() {
        return Ok((None, None, 0));
    }

    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let Some(&id) = by_origin.get(&item.origin) else {
            return Err("the bookmark to update could not be found in the PDF outline".into());
        };
        ids.push(id);
    }

    let mut visible_total = 0i64;

    for (index, (item, &id)) in items.iter().zip(&ids).enumerate() {
        kept.insert(id);

        let (child_first, child_last, child_visible) =
            relink_outline_level(document, id, &item.children, by_origin, closed, kept)?;

        let dict = document
            .get_dictionary_mut(id)
            .map_err(|error| format!("bookmark object is invalid: {error}"))?;
        dict.set("Title", encode_outline_title(&item.title));
        dict.set("Parent", Object::Reference(parent_id));

        if let Some(prev) = index.checked_sub(1).and_then(|i| ids.get(i)) {
            dict.set("Prev", Object::Reference(*prev));
        } else {
            dict.remove(b"Prev");
        }

        if let Some(next) = ids.get(index + 1) {
            dict.set("Next", Object::Reference(*next));
        } else {
            dict.remove(b"Next");
        }

        if let (Some(first), Some(last)) = (child_first, child_last) {
            dict.set("First", Object::Reference(first));
            dict.set("Last", Object::Reference(last));
            if closed.contains(&id) {
                dict.set("Count", Object::Integer(-child_visible));
                visible_total += 1;
            } else {
                dict.set("Count", Object::Integer(child_visible));
                visible_total += 1 + child_visible;
            }
        } else {
            dict.remove(b"First");
            dict.remove(b"Last");
            dict.remove(b"Count");
            visible_total += 1;
        }
    }

    Ok((ids.first().copied(), ids.last().copied(), visible_total))
}

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
