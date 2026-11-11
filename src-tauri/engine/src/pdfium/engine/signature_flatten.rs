//! Signatures flattened into their pages: each signed signature widget drawn
//! as page content from its own appearance, then the widget and its field
//! gone. PDFium's `FPDFPage_Flatten` takes a whole page, burning in every other
//! annotation and dropping links and hidden ones, so this works with lopdf on
//! PDFium's fresh output instead. Widgets are found on the pages, not through
//! `/AcroForm`, which a page copied into a new document no longer has; a
//! signed field the form lists with no widget on any page goes too.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

/// Deeper than any real field tree; a cycle stops here.
const MAX_FIELD_DEPTH: usize = 32;

/// Annotation flags under which nothing of the widget shows (Hidden, NoView).
const INVISIBLE_FLAGS: i64 = 0b10_0010;

/// `bytes` with every signed signature widget drawn into its page and gone,
/// or `None` where there is none. `bytes` must be PDFium's own fresh output,
/// or lopdf's rewrite of it.
pub(super) fn flatten_signatures(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut document = Document::load_mem(bytes)
        .map_err(|error| format!("the rewrite could not be read for its signatures: {error}"))?;
    let mut fields = HashSet::new();
    let mut serial = 0;
    let mut flattened = false;

    for page_id in document.get_pages().into_values().collect::<Vec<_>>() {
        flattened |= flatten_page(&mut document, page_id, &mut fields, &mut serial)?;
    }

    let acro_form = acro_form_slot(&document);

    flattened |= pageless_signed_fields(&document, acro_form.as_ref(), &mut fields);

    if !flattened {
        return Ok(None);
    }

    for field in fields {
        detach_field(&mut document, field, acro_form.as_ref(), 0);
    }

    tidy_catalog(&mut document, acro_form.as_ref());
    document.prune_objects();

    let mut written = Vec::new();
    document
        .save_to(&mut written)
        .map_err(|error| format!("the flattened document could not be written: {error}"))?;

    Ok(Some(written))
}

/// A dictionary in place: an object of its own, or nested under `path` in one.
#[derive(Clone)]
struct Slot {
    object: ObjectId,
    path: Vec<&'static [u8]>,
}

impl Slot {
    fn object(object: ObjectId) -> Self {
        Self {
            object,
            path: Vec::new(),
        }
    }

    fn child(&self, key: &'static [u8]) -> Self {
        let mut path = self.path.clone();
        path.push(key);

        Self {
            object: self.object,
            path,
        }
    }
}

fn dict<'a>(document: &'a Document, slot: &Slot) -> Option<&'a Dictionary> {
    let mut dict = document.get_dictionary(slot.object).ok()?;

    for key in &slot.path {
        dict = dict.get(key).ok()?.as_dict().ok()?;
    }

    Some(dict)
}

fn dict_mut<'a>(document: &'a mut Document, slot: &Slot) -> Option<&'a mut Dictionary> {
    let mut dict = document.get_dictionary_mut(slot.object).ok()?;

    for key in &slot.path {
        dict = dict.get_mut(key).ok()?.as_dict_mut().ok()?;
    }

    Some(dict)
}

/// The dictionary at `key` of `parent`, made an empty one when absent.
fn child_dict(document: &mut Document, parent: &Slot, key: &'static [u8]) -> Option<Slot> {
    let dict = dict_mut(document, parent)?;

    match dict.get(key) {
        Ok(Object::Reference(id)) => Some(Slot::object(*id)),
        Ok(Object::Dictionary(_)) => Some(parent.child(key)),
        _ => {
            dict.set(key, Dictionary::new());
            Some(parent.child(key))
        }
    }
}

/// The array at `key` of `owner`, through one reference to it.
fn array_mut<'a>(
    document: &'a mut Document,
    owner: &Slot,
    key: &[u8],
) -> Option<&'a mut Vec<Object>> {
    let reference = match dict(document, owner)?.get(key).ok()? {
        Object::Reference(id) => Some(*id),
        Object::Array(_) => None,
        _ => return None,
    };

    match reference {
        Some(id) => document.get_object_mut(id).ok()?.as_array_mut().ok(),
        None => dict_mut(document, owner)?
            .get_mut(key)
            .ok()?
            .as_array_mut()
            .ok(),
    }
}

fn acro_form_slot(document: &Document) -> Option<Slot> {
    let root = document.trailer.get(b"Root").ok()?.as_reference().ok()?;

    match document.get_dictionary(root).ok()?.get(b"AcroForm").ok()? {
        Object::Reference(id) => Some(Slot::object(*id)),
        Object::Dictionary(_) => Some(Slot::object(root).child(b"AcroForm")),
        _ => None,
    }
}

/// The terminal field a widget belongs to, when that is a signed signature
/// field: `/FT` and `/V` both inherit down the field tree.
fn signed_signature_field(
    document: &Document,
    widget_id: ObjectId,
    widget: &Dictionary,
) -> Option<ObjectId> {
    // A widget merged with its field carries the field's `/T`; a kid widget
    // has none and names its field as `/Parent`.
    let field = if widget.has(b"T") || !widget.has(b"Parent") {
        widget_id
    } else {
        widget.get(b"Parent").ok()?.as_reference().ok()?
    };
    let mut current = Some(field);
    let mut field_type = None;
    let mut signed = false;

    for _ in 0..MAX_FIELD_DEPTH {
        let Some(id) = current else {
            break;
        };
        let node = document.get_dictionary(id).ok()?;

        field_type = field_type.or_else(|| node.get(b"FT").and_then(Object::as_name).ok());
        signed |= node.get(b"V").is_ok_and(|value| !value.is_null());
        current = node.get(b"Parent").and_then(Object::as_reference).ok();
    }

    (field_type == Some(b"Sig".as_slice()) && signed).then_some(field)
}

/// Adds the form's signed signature fields that no page's widget led to —
/// an invisible signature whose widget sits on no page — answering whether
/// there were any. With nothing to draw, they only have to go.
fn pageless_signed_fields(
    document: &Document,
    acro_form: Option<&Slot>,
    fields: &mut HashSet<ObjectId>,
) -> bool {
    let Some(top) = acro_form
        .and_then(|form| dict(document, form))
        .and_then(|form| form.get(b"Fields").ok())
        .and_then(|top| document.dereference(top).ok())
        .and_then(|(_, top)| top.as_array().ok())
    else {
        return false;
    };
    let mut pending: Vec<ObjectId> = top
        .iter()
        .filter_map(|item| item.as_reference().ok())
        .collect();
    let mut seen = HashSet::new();
    let mut found = false;

    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }

        let Ok(node) = document.get_dictionary(id) else {
            continue;
        };
        // Kids with a `/T` are fields of their own; the rest are widgets.
        let kids: Vec<ObjectId> = node
            .get(b"Kids")
            .ok()
            .and_then(|kids| document.dereference(kids).ok())
            .and_then(|(_, kids)| kids.as_array().ok())
            .into_iter()
            .flatten()
            .filter_map(|kid| kid.as_reference().ok())
            .filter(|kid| document.get_dictionary(*kid).is_ok_and(|kid| kid.has(b"T")))
            .collect();

        if !kids.is_empty() {
            pending.extend(kids);
        } else if signed_signature_field(document, id, node) == Some(id) {
            found |= fields.insert(id);
        }
    }

    found
}

/// Draws the page's signed signature widgets into it and takes them off its
/// annotations; `true` if it had any.
fn flatten_page(
    document: &mut Document,
    page_id: ObjectId,
    fields: &mut HashSet<ObjectId>,
    serial: &mut usize,
) -> Result<bool, String> {
    let page = Slot::object(page_id);
    let Some(annotations) = array_mut(document, &page, b"Annots").map(|items| items.clone()) else {
        return Ok(false);
    };
    let mut kept = Vec::new();
    let mut widgets = Vec::new();

    for annotation in annotations {
        let signed = annotation.as_reference().ok().and_then(|id| {
            let dict = document.get_dictionary(id).ok()?;

            (dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Widget".as_slice()))
                .then_some(())?;
            signed_signature_field(document, id, dict).map(|field| (id, field))
        });

        match signed {
            Some((widget, field)) => {
                fields.insert(field);
                widgets.push(widget);
            }
            None => kept.push(annotation),
        }
    }

    if widgets.is_empty() {
        return Ok(false);
    }

    let placements: Vec<_> = widgets
        .iter()
        .filter_map(|&widget| placement(document, widget))
        .collect();

    if let Some(items) = array_mut(document, &page, b"Annots") {
        *items = kept;
    }

    if !placements.is_empty() {
        draw(document, page_id, &placements, serial)?;
    }

    Ok(true)
}

fn numbers<const N: usize>(document: &Document, object: &Object) -> Option<[f32; N]> {
    let (_, object) = document.dereference(object).ok()?;
    let items = object.as_array().ok()?;

    if items.len() != N {
        return None;
    }

    let mut values = [0.0; N];

    for (value, item) in values.iter_mut().zip(items) {
        *value = document.dereference(item).ok()?.1.as_float().ok()?;

        if !value.is_finite() {
            return None;
        }
    }

    Some(values)
}

/// `[left, bottom, right, top]`, whichever corners the array names.
fn rectangle(document: &Document, object: &Object) -> Option<[f32; 4]> {
    let [a, b, c, d] = numbers::<4>(document, object)?;

    Some([a.min(c), b.min(d), a.max(c), b.max(d)])
}

/// The widget's normal appearance stream: `/N` itself, or the one its `/AS`
/// state picks from `/N`'s states.
fn appearance(document: &Document, widget: &Dictionary) -> Option<ObjectId> {
    let (_, appearances) = document.dereference(widget.get(b"AP").ok()?).ok()?;
    let normal = appearances.as_dict().ok()?.get(b"N").ok()?;

    if let Ok(id) = normal.as_reference() {
        if matches!(document.get_object(id), Ok(Object::Stream(_))) {
            return Some(id);
        }
    }

    let (_, states) = document.dereference(normal).ok()?;
    let state = widget.get(b"AS").and_then(Object::as_name).ok()?;

    states.as_dict().ok()?.get(state).ok()?.as_reference().ok()
}

/// The appearance stream and the `cm` that lays its box, as its own `/Matrix`
/// places it, onto the widget's rectangle (ISO 32000-1, 12.5.5). The form's
/// matrix is not in it: `Do` applies that itself.
fn placement(document: &Document, widget_id: ObjectId) -> Option<(ObjectId, [f32; 6])> {
    let widget = document.get_dictionary(widget_id).ok()?;

    if widget.get(b"F").and_then(Object::as_i64).unwrap_or(0) & INVISIBLE_FLAGS != 0 {
        return None;
    }

    let [left, bottom, right, top] = rectangle(document, widget.get(b"Rect").ok()?)?;
    let stream_id = appearance(document, widget)?;
    let stream = document.get_object(stream_id).ok()?.as_stream().ok()?;
    let [box_left, box_bottom, box_right, box_top] =
        rectangle(document, stream.dict.get(b"BBox").ok()?)?;
    let [a, b, c, d, e, f] = stream
        .dict
        .get(b"Matrix")
        .ok()
        .and_then(|matrix| numbers::<6>(document, matrix))
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let corners = [
        (box_left, box_bottom),
        (box_right, box_bottom),
        (box_left, box_top),
        (box_right, box_top),
    ]
    .map(|(x, y)| (a * x + c * y + e, b * x + d * y + f));
    let min_x = corners
        .iter()
        .map(|corner| corner.0)
        .fold(f32::INFINITY, f32::min);
    let max_x = corners
        .iter()
        .map(|corner| corner.0)
        .fold(f32::NEG_INFINITY, f32::max);
    let min_y = corners
        .iter()
        .map(|corner| corner.1)
        .fold(f32::INFINITY, f32::min);
    let max_y = corners
        .iter()
        .map(|corner| corner.1)
        .fold(f32::NEG_INFINITY, f32::max);

    if max_x - min_x <= 0.0 || max_y - min_y <= 0.0 {
        return None;
    }

    let scale_x = (right - left) / (max_x - min_x);
    let scale_y = (top - bottom) / (max_y - min_y);
    let matrix = [
        scale_x,
        0.0,
        0.0,
        scale_y,
        left - min_x * scale_x,
        bottom - min_y * scale_y,
    ];

    matrix
        .iter()
        .all(|value| value.is_finite())
        .then_some((stream_id, matrix))
}

/// The page's own resources, copied down from the tree when it inherits them:
/// a name added to an inherited dictionary would reach every page under it.
fn page_resources(document: &mut Document, page_id: ObjectId) -> Option<Slot> {
    let page = Slot::object(page_id);

    match dict(document, &page)?.get(b"Resources") {
        Ok(Object::Reference(id)) => return Some(Slot::object(*id)),
        Ok(Object::Dictionary(_)) => return Some(page.child(b"Resources")),
        _ => {}
    }

    let mut parent = dict(document, &page)?
        .get(b"Parent")
        .and_then(Object::as_reference)
        .ok();
    let mut inherited = Dictionary::new();

    for _ in 0..MAX_FIELD_DEPTH {
        let Some(id) = parent else {
            break;
        };
        let node = document.get_dictionary(id).ok()?;

        if let Ok(resources) = node.get(b"Resources") {
            if let Ok((_, Object::Dictionary(found))) = document.dereference(resources) {
                inherited = found.clone();
            }
            break;
        }

        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }

    dict_mut(document, &page)?.set("Resources", inherited);
    Some(page.child(b"Resources"))
}

fn draw(
    document: &mut Document,
    page_id: ObjectId,
    placements: &[(ObjectId, [f32; 6])],
    serial: &mut usize,
) -> Result<(), String> {
    let missing = || format!("page {page_id:?} has no usable resources to draw a signature with");
    let resources = page_resources(document, page_id).ok_or_else(missing)?;
    let xobjects = child_dict(document, &resources, b"XObject").ok_or_else(missing)?;
    // Led by a newline: a page stream may end without one, and the streams
    // read as one.
    let mut operators = String::from("\nQ\n");

    for &(stream_id, [a, b, c, d, e, f]) in placements {
        // An appearance stream is a form XObject in all but, sometimes, name.
        if let Ok(Object::Stream(stream)) = document.get_object_mut(stream_id) {
            stream.dict.set("Type", Object::Name(b"XObject".to_vec()));
            stream.dict.set("Subtype", Object::Name(b"Form".to_vec()));
        }

        let names = dict_mut(document, &xobjects).ok_or_else(missing)?;
        let name = loop {
            let name = format!("TFolioSignature{serial}");
            *serial += 1;

            if !names.has(name.as_bytes()) {
                break name;
            }
        };

        names.set(name.as_bytes(), Object::Reference(stream_id));
        operators.push_str(&format!("q {a} {b} {c} {d} {e} {f} cm /{name} Do Q\n"));
    }

    // Wrapped, so whatever state the page's own content leaves behind cannot
    // move or recolour what is drawn after it.
    let contents = match document
        .get_dictionary(page_id)
        .map_err(|error| error.to_string())?
        .get(b"Contents")
    {
        Ok(Object::Reference(id)) => match document.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            Ok(_) => vec![Object::Reference(*id)],
            Err(_) => Vec::new(),
        },
        Ok(Object::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let open = document.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
    let close = document.add_object(Stream::new(Dictionary::new(), operators.into_bytes()));
    let mut wrapped = Vec::with_capacity(contents.len() + 2);

    wrapped.push(Object::Reference(open));
    wrapped.extend(contents);
    wrapped.push(Object::Reference(close));
    document
        .get_dictionary_mut(page_id)
        .map_err(|error| error.to_string())?
        .set("Contents", Object::Array(wrapped));

    Ok(())
}

/// Takes `field` out of the tree: off its parent's `/Kids`, or `/AcroForm`'s
/// `/Fields` at the top, and a parent left with no kids after it.
fn detach_field(document: &mut Document, field: ObjectId, acro_form: Option<&Slot>, depth: usize) {
    if depth > MAX_FIELD_DEPTH {
        return;
    }

    let parent = document
        .get_dictionary(field)
        .ok()
        .and_then(|node| node.get(b"Parent").ok())
        .and_then(|parent| parent.as_reference().ok());
    let (owner, key) = match parent {
        Some(parent) => (Slot::object(parent), b"Kids".as_slice()),
        None => match acro_form {
            Some(form) => (form.clone(), b"Fields".as_slice()),
            None => return,
        },
    };
    let Some(items) = array_mut(document, &owner, key) else {
        return;
    };

    items.retain(|item| item.as_reference().ok() != Some(field));

    if items.is_empty() {
        if let Some(parent) = parent {
            detach_field(document, parent, acro_form, depth + 1);
        }
    }
}

/// With its signatures gone the document claims none: no `/SigFlags`, and no
/// `/Perms`, whose DocMDP entry would keep a removed signature reachable.
fn tidy_catalog(document: &mut Document, acro_form: Option<&Slot>) {
    if let Some(form) = acro_form {
        if dict(document, form)
            .and_then(|form| form.get(b"Fields").ok())
            .and_then(|fields| document.dereference(fields).ok())
            .and_then(|(_, fields)| fields.as_array().ok())
            .is_none_or(|fields| fields.is_empty())
        {
            if let Some(form) = dict_mut(document, form) {
                form.remove(b"SigFlags");
            }
        }
    }

    if let Ok(catalog) = document.catalog_mut() {
        catalog.remove(b"Perms");
    }
}
