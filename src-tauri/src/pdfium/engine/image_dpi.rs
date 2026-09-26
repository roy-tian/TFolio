use std::collections::HashMap;

use lopdf::{content::Content, Dictionary, Document, Object, ObjectId};

// Forms nest; a chain deeper than this is malformed or hostile, and whatever
// it draws keeps its pixels.
const MAX_FORM_DEPTH: usize = 12;

// Past this much decoded content a page or form is skipped, not parsed: a few
// kilobytes of flate can inflate without bound. Its images keep their pixels.
const MAX_CONTENT_BYTES: usize = 64 << 20;

// Also the parent chain's bound, which a cycle would otherwise walk forever.
const MAX_PAGE_TREE_DEPTH: usize = 64;

/// `[a b c d e f]`, PDF's row-vector affine matrix.
type Matrix = [f32; 6];

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `first` applied, then `then` — the order `cm` and a form's `/Matrix`
/// compose with the matrix already current.
fn multiply(first: &Matrix, then: &Matrix) -> Matrix {
    [
        first[0] * then[0] + first[1] * then[2],
        first[0] * then[1] + first[1] * then[3],
        first[2] * then[0] + first[3] * then[2],
        first[2] * then[1] + first[3] * then[3],
        first[4] * then[0] + first[5] * then[2] + then[4],
        first[4] * then[1] + first[5] * then[3] + then[5],
    ]
}

fn matrix(operands: &[Object]) -> Option<Matrix> {
    let values: Vec<f32> = operands
        .iter()
        .map(|operand| operand.as_float().ok())
        .collect::<Option<_>>()?;

    values.try_into().ok()
}

fn dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match object {
        Object::Reference(id) => document.get_object(*id).ok()?.as_dict().ok(),
        Object::Dictionary(dict) => Some(dict),
        _ => None,
    }
}

/// The page's own resources, else the nearest ancestor's: the page tree
/// passes them down.
fn page_resources(document: &Document, page_id: ObjectId) -> Option<&Dictionary> {
    let mut node = document.get_dictionary(page_id).ok()?;

    for _ in 0..MAX_PAGE_TREE_DEPTH {
        if let Ok(resources) = node.get(b"Resources") {
            return dictionary(document, resources);
        }

        node = document
            .get_dictionary(node.get(b"Parent").ok()?.as_reference().ok()?)
            .ok()?;
    }

    None
}

struct Walk<'a> {
    document: &'a Document,
    dpis: HashMap<ObjectId, f32>,
    forms: Vec<ObjectId>,
}

impl<'a> Walk<'a> {
    fn content(&mut self, content: &[u8], resources: Option<&'a Dictionary>, base: Matrix) {
        // An unparseable stream draws nothing this pass can place.
        let Ok(content) = Content::decode(content) else {
            return;
        };
        let mut current = base;
        let mut saved = Vec::new();

        for operation in content.operations {
            match operation.operator.as_str() {
                "q" => saved.push(current),
                "Q" => current = saved.pop().unwrap_or(current),
                "cm" => {
                    if let Some(cm) = matrix(&operation.operands) {
                        current = multiply(&cm, &current);
                    }
                }
                "Do" => {
                    if let Some(name) = operation.operands.first().and_then(|o| o.as_name().ok()) {
                        self.draw(name, resources, current);
                    }
                }
                _ => {}
            }
        }
    }

    fn draw(&mut self, name: &[u8], resources: Option<&'a Dictionary>, current: Matrix) {
        let document = self.document;
        let Some(id) = resources
            .and_then(|resources| resources.get(b"XObject").ok())
            .and_then(|xobjects| dictionary(document, xobjects))
            .and_then(|xobjects| xobjects.get(name).ok())
            .and_then(|xobject| xobject.as_reference().ok())
        else {
            return;
        };
        let Ok(stream) = document.get_object(id).and_then(Object::as_stream) else {
            return;
        };

        match stream.dict.get(b"Subtype").and_then(Object::as_name) {
            Ok(b"Image") => self.record(id, &stream.dict, current),
            Ok(b"Form") => {
                if self.forms.len() >= MAX_FORM_DEPTH || self.forms.contains(&id) {
                    return;
                }

                let form_matrix = stream
                    .dict
                    .get(b"Matrix")
                    .and_then(Object::as_array)
                    .ok()
                    .and_then(|operands| matrix(operands))
                    .unwrap_or(IDENTITY);
                // A form without resources of its own uses its caller's, an
                // older convention readers still honour.
                let form_resources = stream
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|resources| dictionary(document, resources))
                    .or(resources);
                let Ok(content) = stream.get_plain_content_with_limit(MAX_CONTENT_BYTES) else {
                    return;
                };

                self.forms.push(id);
                self.content(&content, form_resources, multiply(&form_matrix, &current));
                self.forms.pop();
            }
            _ => {}
        }
    }

    /// An image paints the unit square, so the current matrix's axes are its
    /// drawn size in points.
    fn record(&mut self, id: ObjectId, dict: &Dictionary, current: Matrix) {
        let pixels = |key: &[u8]| dict.get(key).and_then(Object::as_i64).ok();
        let (Some(width), Some(height)) = (pixels(b"Width"), pixels(b"Height")) else {
            return;
        };
        let drawn_width = current[0].hypot(current[1]);
        let drawn_height = current[2].hypot(current[3]);

        // A degenerate draw shows nothing, so it asks nothing of the pixels.
        if drawn_width < 0.01 || drawn_height < 0.01 {
            return;
        }

        // The coarser axis: resampling is uniform, so the other axis must not
        // be pushed below what this one needs.
        let dpi = (width as f32 * 72.0 / drawn_width).min(height as f32 * 72.0 / drawn_height);
        let lowest = self.dpis.entry(id).or_insert(f32::INFINITY);

        // Drawn more than once, the largest drawing sets what must survive.
        *lowest = lowest.min(dpi);
    }
}

/// Each image's lowest effective resolution across every page that draws it,
/// in pixels per inch. An image drawn only where this walk does not reach —
/// annotation appearances, patterns, Type 3 glyphs — has no entry, and the
/// compression pass leaves it alone. `None` reports a stop read between pages.
pub(super) fn image_dpis(
    document: &Document,
    cancelled: &dyn Fn() -> bool,
) -> Option<HashMap<ObjectId, f32>> {
    let mut walk = Walk {
        document,
        dpis: HashMap::new(),
        forms: Vec::new(),
    };

    for page_id in document.page_iter() {
        if cancelled() {
            return None;
        }

        let Ok(content) = document.get_page_content_with_limit(page_id, MAX_CONTENT_BYTES) else {
            continue;
        };

        walk.content(&content, page_resources(document, page_id), IDENTITY);
    }

    Some(walk.dpis)
}
