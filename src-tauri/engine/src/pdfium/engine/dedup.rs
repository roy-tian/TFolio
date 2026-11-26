use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId};
use sha2::{Digest, Sha256};

const MAX_COMPARE_DEPTH: usize = 32;

const PROTECTED_STREAM_TYPES: &[&[u8]] = &[
    b"ObjStm",
    b"XRef",
    b"Metadata",
    b"Page",
    b"Pages",
    b"Catalog",
    b"Annot",
    b"Sig",
    b"StructElem",
    b"StructTreeRoot",
    b"OCG",
];

const IDENTITY_KEYS: &[&[u8]] = &[
    b"Parent",
    b"P",
    b"Prev",
    b"Next",
    b"First",
    b"Last",
    b"StructParent",
    b"StructParents",
    b"Kids",
    b"Annots",
    b"Fields",
];

const SAFE_DICT_TYPES: &[&[u8]] = &[
    b"Font",
    b"FontDescriptor",
    b"ExtGState",
    b"Encoding",
    b"Pattern",
    b"Halftone",
];

const COLOR_SPACE_ARRAY_NAMES: &[&[u8]] = &[
    b"ICCBased",
    b"CalGray",
    b"CalRGB",
    b"Lab",
    b"Indexed",
    b"Separation",
    b"DeviceN",
    b"Pattern",
];

const SAFE_ARRAY_REF_KEYS: &[&[u8]] = &[
    b"ColorSpace",
    b"W",
    b"W2",
    b"Widths",
    b"DescendantFonts",
    b"ProcSet",
    b"Functions",
];

fn dict_type(dict: &Dictionary) -> Option<&[u8]> {
    dict.get(b"Type").ok()?.as_name().ok()
}

fn has_identity_key(dict: &Dictionary) -> bool {
    IDENTITY_KEYS.iter().any(|key| dict.has(key))
}

fn is_cid_system_info(dict: &Dictionary) -> bool {
    dict.has(b"Registry")
        && dict.has(b"Ordering")
        && dict
            .iter()
            .all(|(key, _)| matches!(key.as_slice(), b"Registry" | b"Ordering" | b"Supplement"))
}

fn is_shading_dict(dict: &Dictionary) -> bool {
    dict.has(b"ShadingType") && dict.has(b"ColorSpace")
}

fn is_color_space_array(items: &[Object]) -> bool {
    items
        .first()
        .and_then(|first| first.as_name().ok())
        .is_some_and(|name| COLOR_SPACE_ARRAY_NAMES.contains(&name))
}

fn is_deduplicable(
    id: ObjectId,
    object: &Object,
    protected: &HashSet<ObjectId>,
    safe_arrays: &HashSet<ObjectId>,
) -> bool {
    if protected.contains(&id) {
        return false;
    }

    match object {
        Object::Stream(stream) => {
            if has_identity_key(&stream.dict) {
                return false;
            }
            if let Some(kind) = dict_type(&stream.dict) {
                if PROTECTED_STREAM_TYPES.contains(&kind) {
                    return false;
                }
            }
            true
        }
        Object::Dictionary(dict) => {
            if has_identity_key(dict) {
                return false;
            }
            dict_type(dict).is_some_and(|kind| SAFE_DICT_TYPES.contains(&kind))
                || is_cid_system_info(dict)
                || is_shading_dict(dict)
        }
        Object::Array(items) => {
            !items.is_empty() && (is_color_space_array(items) || safe_arrays.contains(&id))
        }
        _ => false,
    }
}

fn collect_references(object: &Object, out: &mut Vec<ObjectId>) {
    let mut stack = vec![object];

    while let Some(current) = stack.pop() {
        match current {
            Object::Reference(id) => out.push(*id),
            Object::Array(items) => stack.extend(items.iter()),
            Object::Dictionary(dict) => {
                for (_, value) in dict.iter() {
                    stack.push(value);
                }
            }
            Object::Stream(stream) => {
                for (_, value) in stream.dict.iter() {
                    stack.push(value);
                }
            }
            _ => {}
        }
    }
}

fn push_dict_array_refs<'a>(dict: &'a Dictionary, stack: &mut Vec<(bool, &'a Object)>) {
    for (key, value) in dict.iter() {
        stack.push((SAFE_ARRAY_REF_KEYS.contains(&key.as_slice()), value));
    }
}

fn visit_dict_array_refs(
    dict: &Dictionary,
    seen_safe: &mut HashSet<ObjectId>,
    seen_unsafe: &mut HashSet<ObjectId>,
) {
    let mut stack = Vec::new();
    push_dict_array_refs(dict, &mut stack);

    while let Some((is_safe, object)) = stack.pop() {
        match object {
            Object::Reference(id) => {
                if is_safe {
                    seen_safe.insert(*id);
                } else {
                    seen_unsafe.insert(*id);
                }
            }
            Object::Array(items) => {
                for item in items {
                    stack.push((false, item));
                }
            }
            Object::Dictionary(nested) => push_dict_array_refs(nested, &mut stack),
            Object::Stream(stream) => push_dict_array_refs(&stream.dict, &mut stack),
            _ => {}
        }
    }
}

/// Indirect arrays referenced solely from immutable resource dictionary keys
/// (such as font `/Widths`, `/W`, `/DescendantFonts`, `/ColorSpace`, `/ProcSet`).
/// Mutable structural arrays such as `/Annots` or `/Kids` are never included.
fn safe_indirect_arrays(document: &Document) -> HashSet<ObjectId> {
    let mut seen_safe = HashSet::new();
    let mut seen_unsafe = HashSet::new();
    let mut refs = Vec::new();

    for (_, value) in document.trailer.iter() {
        collect_references(value, &mut refs);
    }
    seen_unsafe.extend(refs.drain(..));

    for object in document.objects.values() {
        match object {
            Object::Dictionary(dict) => {
                visit_dict_array_refs(dict, &mut seen_safe, &mut seen_unsafe);
            }
            Object::Stream(stream) => {
                visit_dict_array_refs(&stream.dict, &mut seen_safe, &mut seen_unsafe);
            }
            other => {
                collect_references(other, &mut refs);
                seen_unsafe.extend(refs.drain(..));
            }
        }
    }

    seen_safe
        .into_iter()
        .filter(|id| !seen_unsafe.contains(id))
        .collect()
}

fn sorted_dict_entries(dict: &Dictionary, skip_length: bool) -> Vec<(&[u8], &Object)> {
    let mut entries: Vec<(&[u8], &Object)> = dict
        .iter()
        .filter(|(key, _)| !(skip_length && key.as_slice() == b"Length"))
        .map(|(key, value)| (key.as_slice(), value))
        .collect();
    entries.sort_unstable_by_key(|(a, _)| *a);
    entries
}

fn canonical_real_bits(value: f32) -> u32 {
    let normalized = if value == 0.0 { 0.0 } else { value };
    normalized.to_bits()
}

fn hash_dict(hasher: &mut Sha256, dict: &Dictionary, skip_length: bool, depth: usize) -> bool {
    if depth >= MAX_COMPARE_DEPTH {
        return false;
    }

    let entries = sorted_dict_entries(dict, skip_length);
    hasher.update([7]);
    hasher.update((entries.len() as u64).to_le_bytes());

    for (key, value) in entries {
        hasher.update((key.len() as u64).to_le_bytes());
        hasher.update(key);
        if !hash_object(hasher, value, depth + 1) {
            return false;
        }
    }

    true
}

fn hash_object(hasher: &mut Sha256, object: &Object, depth: usize) -> bool {
    if depth >= MAX_COMPARE_DEPTH {
        return false;
    }

    match object {
        Object::Null => hasher.update([0]),
        Object::Boolean(value) => hasher.update([1, u8::from(*value)]),
        Object::Integer(value) => {
            hasher.update([2]);
            hasher.update(value.to_le_bytes());
        }
        Object::Real(value) => {
            hasher.update([3]);
            hasher.update(canonical_real_bits(*value).to_le_bytes());
        }
        Object::Name(bytes) => {
            hasher.update([4]);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        Object::String(bytes, _) => {
            hasher.update([5]);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        Object::Array(items) => {
            hasher.update([6]);
            hasher.update((items.len() as u64).to_le_bytes());
            for item in items {
                if !hash_object(hasher, item, depth + 1) {
                    return false;
                }
            }
        }
        Object::Dictionary(dict) => {
            if !hash_dict(hasher, dict, false, depth) {
                return false;
            }
        }
        Object::Stream(stream) => {
            hasher.update([8]);
            if !hash_dict(hasher, &stream.dict, true, depth + 1) {
                return false;
            }
            hasher.update((stream.content.len() as u64).to_le_bytes());
            hasher.update(&stream.content);
        }
        Object::Reference((num, gen)) => {
            hasher.update([9]);
            hasher.update(num.to_le_bytes());
            hasher.update(gen.to_le_bytes());
        }
    }

    true
}

fn dicts_canonically_equal(
    a: &Dictionary,
    b: &Dictionary,
    skip_length: bool,
    depth: usize,
) -> bool {
    if depth >= MAX_COMPARE_DEPTH {
        return false;
    }

    let left = sorted_dict_entries(a, skip_length);
    let right = sorted_dict_entries(b, skip_length);

    left.len() == right.len()
        && left
            .into_iter()
            .zip(right)
            .all(|((k1, v1), (k2, v2))| k1 == k2 && objects_canonically_equal(v1, v2, depth + 1))
}

fn objects_canonically_equal(a: &Object, b: &Object, depth: usize) -> bool {
    if depth >= MAX_COMPARE_DEPTH {
        return false;
    }

    match (a, b) {
        (Object::Null, Object::Null) => true,
        (Object::Boolean(x), Object::Boolean(y)) => x == y,
        (Object::Integer(x), Object::Integer(y)) => x == y,
        (Object::Real(x), Object::Real(y)) => canonical_real_bits(*x) == canonical_real_bits(*y),
        (Object::Name(x), Object::Name(y)) => x == y,
        (Object::String(x, _), Object::String(y, _)) => x == y,
        (Object::Reference(x), Object::Reference(y)) => x == y,
        (Object::Array(x), Object::Array(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|(left, right)| objects_canonically_equal(left, right, depth + 1))
        }
        (Object::Dictionary(x), Object::Dictionary(y)) => {
            dicts_canonically_equal(x, y, false, depth)
        }
        (Object::Stream(x), Object::Stream(y)) => {
            x.content == y.content && dicts_canonically_equal(&x.dict, &y.dict, true, depth + 1)
        }
        _ => false,
    }
}

fn rewrite_references(object: &mut Object, remap: &HashMap<ObjectId, ObjectId>) {
    let mut stack = vec![object];

    while let Some(current) = stack.pop() {
        match current {
            Object::Reference(id) => {
                if let Some(&canonical) = remap.get(id) {
                    *id = canonical;
                }
            }
            Object::Array(items) => stack.extend(items.iter_mut()),
            Object::Dictionary(dict) => {
                for (_, value) in dict.iter_mut() {
                    stack.push(value);
                }
            }
            Object::Stream(stream) => {
                for (_, value) in stream.dict.iter_mut() {
                    stack.push(value);
                }
            }
            _ => {}
        }
    }
}

/// Collapses identical immutable streams, resource dictionaries, and resource
/// arrays bottom-up in reverse topological order (ascending `ObjectId` within
/// each wave), then prunes any unreachable objects left behind. Objects named
/// in `excluded` are never merged or removed. Returns the flat canonical
/// remap, or `None` when cancelled.
pub(super) fn deduplicate_objects(
    document: &mut Document,
    cancelled: &dyn Fn() -> bool,
    excluded: &HashSet<ObjectId>,
) -> Option<HashMap<ObjectId, ObjectId>> {
    if cancelled() {
        return None;
    }

    let mut protected = excluded.clone();
    let mut trailer_refs = Vec::new();
    for (_, value) in document.trailer.iter() {
        collect_references(value, &mut trailer_refs);
    }
    protected.extend(trailer_refs);

    let safe_arrays = safe_indirect_arrays(document);
    let mut candidates: Vec<ObjectId> = document
        .objects
        .iter()
        .filter(|(&id, object)| is_deduplicable(id, object, &protected, &safe_arrays))
        .map(|(&id, _)| id)
        .collect();
    candidates.sort_unstable();

    let candidate_set: HashSet<ObjectId> = candidates.iter().copied().collect();
    let mut out_degree: HashMap<ObjectId, usize> = HashMap::with_capacity(candidates.len());
    let mut reverse_edges: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    let mut refs = Vec::new();
    let mut unique_deps = HashSet::new();

    for &id in &candidates {
        refs.clear();
        unique_deps.clear();
        if let Some(object) = document.objects.get(&id) {
            collect_references(object, &mut refs);
        }
        for dep in &refs {
            if *dep != id && candidate_set.contains(dep) && unique_deps.insert(*dep) {
                reverse_edges.entry(*dep).or_default().push(id);
            }
        }
        out_degree.insert(id, unique_deps.len());
    }

    let mut wave: Vec<ObjectId> = candidates
        .iter()
        .copied()
        .filter(|id| out_degree.get(id) == Some(&0))
        .collect();
    let mut buckets: HashMap<[u8; 32], Vec<ObjectId>> = HashMap::new();
    let mut remap: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut visited: HashSet<ObjectId> = HashSet::with_capacity(candidates.len());

    // Process acyclic candidates bottom-up wave by wave: every child reference
    // of a node in this wave is already canonicalized, so arbitrary DAG depth
    // collapses in one pass and each stream's bytes are hashed at most once.
    while !wave.is_empty() {
        wave.sort_unstable();
        let mut next_wave = Vec::new();

        for id in wave {
            if cancelled() {
                return None;
            }

            if !remap.is_empty() {
                if let Some(object) = document.objects.get_mut(&id) {
                    rewrite_references(object, &remap);
                }
            }
            visited.insert(id);

            if let Some(object) = document.objects.get(&id) {
                let mut hasher = Sha256::new();
                if hash_object(&mut hasher, object, 0) {
                    let digest: [u8; 32] = hasher.finalize().into();
                    let bucket = buckets.entry(digest).or_default();
                    if let Some(&canonical) = bucket.iter().find(|&&candidate| {
                        document
                            .objects
                            .get(&candidate)
                            .is_some_and(|existing| objects_canonically_equal(existing, object, 0))
                    }) {
                        remap.insert(id, canonical);
                    } else {
                        bucket.push(id);
                    }
                }
            }

            if let Some(parents) = reverse_edges.get(&id) {
                for &parent in parents {
                    if let Some(degree) = out_degree.get_mut(&parent) {
                        *degree -= 1;
                        if *degree == 0 {
                            next_wave.push(parent);
                        }
                    }
                }
            }
        }

        wave = next_wave;
    }

    if cancelled() {
        return None;
    }

    if !remap.is_empty() {
        for id in remap.keys() {
            document.objects.remove(id);
        }
        for (_, value) in document.trailer.iter_mut() {
            rewrite_references(value, &remap);
        }
        for (&id, object) in document.objects.iter_mut() {
            if !visited.contains(&id) {
                rewrite_references(object, &remap);
            }
        }
    }

    if cancelled() {
        return None;
    }

    if !document.trailer.is_empty() {
        document.prune_objects();
    }

    Some(remap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Stream;

    fn dict(entries: &[(&str, Object)]) -> Dictionary {
        let mut d = Dictionary::new();
        for (k, v) in entries {
            d.set(*k, v.clone());
        }
        d
    }

    #[test]
    fn collapses_deep_nested_form_dags_in_one_pass_and_prunes_orphaned_lengths() {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();

        // Two pages each owning an identical 12-level nested Form XObject DAG
        // (deeper than a fixed 8-pass loop), with an indirect `/Length` on the
        // second copy's leaf stream and an indirect empty `/Resources` dict on
        // a third blank page.
        for copy in 0..2 {
            let mut leaf_dict = dict(&[
                ("Type", Object::Name(b"XObject".to_vec())),
                ("Subtype", Object::Name(b"Form".to_vec())),
                (
                    "BBox",
                    Object::Array(vec![0.into(), 0.into(), 100.into(), 100.into()]),
                ),
            ]);
            if copy == 1 {
                let len_id = doc.add_object(Object::Integer(8));
                leaf_dict.set("Length", Object::Reference(len_id));
            }
            let mut current = doc.add_object(Stream::new(leaf_dict, b"0 0 1 rg".to_vec()));

            for _ in 0..12 {
                let form_dict = dict(&[
                    ("Type", Object::Name(b"XObject".to_vec())),
                    ("Subtype", Object::Name(b"Form".to_vec())),
                    (
                        "BBox",
                        Object::Array(vec![0.into(), 0.into(), 100.into(), 100.into()]),
                    ),
                    (
                        "Resources",
                        Object::Dictionary(dict(&[(
                            "XObject",
                            Object::Dictionary(dict(&[("Fm", Object::Reference(current))])),
                        )])),
                    ),
                ]);
                current = doc.add_object(Stream::new(form_dict, b"/Fm Do".to_vec()));
            }

            let content_id = doc.add_object(Stream::new(Dictionary::new(), b"/Top Do".to_vec()));
            let page_id = doc.add_object(dict(&[
                ("Type", Object::Name(b"Page".to_vec())),
                ("Parent", Object::Reference(pages_id)),
                (
                    "Resources",
                    Object::Dictionary(dict(&[(
                        "XObject",
                        Object::Dictionary(dict(&[("Top", Object::Reference(current))])),
                    )])),
                ),
                ("Contents", Object::Reference(content_id)),
            ]));
            kids.push(Object::Reference(page_id));
        }

        let empty_resources_id = doc.add_object(Object::Dictionary(Dictionary::new()));
        let blank_page_id = doc.add_object(dict(&[
            ("Type", Object::Name(b"Page".to_vec())),
            ("Parent", Object::Reference(pages_id)),
            ("Resources", Object::Reference(empty_resources_id)),
        ]));
        kids.push(Object::Reference(blank_page_id));

        doc.objects.insert(
            pages_id,
            Object::Dictionary(dict(&[
                ("Type", Object::Name(b"Pages".to_vec())),
                ("Kids", Object::Array(kids)),
                ("Count", 3.into()),
            ])),
        );
        let catalog_id = doc.add_object(dict(&[
            ("Type", Object::Name(b"Catalog".to_vec())),
            ("Pages", Object::Reference(pages_id)),
        ]));
        doc.trailer.set("Root", Object::Reference(catalog_id));

        let remap = deduplicate_objects(&mut doc, &|| false, &HashSet::new()).unwrap();
        // All 13 duplicate Form XObjects (leaf + 12 wrappers) + duplicate content stream collapsed.
        assert_eq!(remap.len(), 14);

        let form_count = doc
            .objects
            .values()
            .filter(|object| {
                object.as_stream().is_ok_and(|stream| {
                    stream
                        .dict
                        .get(b"Subtype")
                        .ok()
                        .and_then(|o| o.as_name().ok())
                        == Some(b"Form")
                })
            })
            .count();
        assert_eq!(form_count, 13);

        // Indirect `/Length` integer from the collapsed leaf stream was pruned.
        let orphan_ints = doc
            .objects
            .values()
            .filter(|object| matches!(object, Object::Integer(_)))
            .count();
        assert_eq!(orphan_ints, 0);

        // Indirect empty `/Resources` dictionary referenced by the blank page survived.
        assert!(doc.objects.contains_key(&empty_resources_id));
    }

    #[test]
    fn excluded_objects_stay_distinct() {
        let mut doc = Document::with_version("1.5");
        let a = doc.add_object(Stream::new(Dictionary::new(), b"same-bytes".to_vec()));
        let b = doc.add_object(Stream::new(Dictionary::new(), b"same-bytes".to_vec()));
        let root = doc.add_object(dict(&[
            ("Type", Object::Name(b"Catalog".to_vec())),
            ("A", Object::Reference(a)),
            ("B", Object::Reference(b)),
        ]));
        doc.trailer.set("Root", Object::Reference(root));

        let excluded: HashSet<ObjectId> = [a, b].into_iter().collect();
        let remap = deduplicate_objects(&mut doc, &|| false, &excluded).unwrap();
        assert!(remap.is_empty());
        assert!(doc.objects.contains_key(&a));
        assert!(doc.objects.contains_key(&b));
    }
}
