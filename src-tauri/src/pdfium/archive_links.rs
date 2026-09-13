use lopdf::{Document, Object};
use pdfium_render::prelude::*;

use super::outline::{install_outline, OutlineNode};

pub(super) struct PageLink {
    annotation: usize,
    target: i32,
    view: PdfDestinationViewSettings,
}

pub(super) fn collect_links(page: &PdfPage<'_>) -> Result<Vec<PageLink>, String> {
    let mut links = Vec::new();
    for (index, annotation) in page.annotations().iter().enumerate() {
        let Some(annotation) = annotation.as_link_annotation() else {
            continue;
        };
        let link = annotation
            .link()
            .map_err(|error| format!("could not read a page link: {error}"))?;
        let action = link.action();
        let destination = link.destination().or_else(|| {
            action
                .as_ref()
                .and_then(|action| action.as_local_destination_action())
                .and_then(|action| action.destination().ok())
        });
        let Some(destination) = destination else {
            continue;
        };
        let Ok(target) = destination.page_index() else {
            continue;
        };
        links.push(PageLink {
            annotation: index,
            target,
            view: destination
                .view_settings()
                .unwrap_or(PdfDestinationViewSettings::FitPageToWindow),
        });
    }
    Ok(links)
}

fn view_operands(view: PdfDestinationViewSettings) -> Vec<Object> {
    use PdfDestinationViewSettings::*;
    let number = |value: Option<f32>| {
        value
            .filter(|value| value.is_finite())
            .map_or(Object::Null, Object::Real)
    };
    let coordinate = |value: Option<PdfPoints>| number(value.map(|value| value.value));
    let (name, parameters) = match view {
        SpecificCoordinatesAndZoom(x, y, zoom) => {
            ("XYZ", vec![coordinate(x), coordinate(y), number(zoom)])
        }
        FitPageHorizontallyToWindow(y) => ("FitH", vec![coordinate(y)]),
        FitPageVerticallyToWindow(x) => ("FitV", vec![coordinate(x)]),
        FitPageToRectangle(rect) => (
            "FitR",
            vec![
                number(Some(rect.left().value)),
                number(Some(rect.bottom().value)),
                number(Some(rect.right().value)),
                number(Some(rect.top().value)),
            ],
        ),
        FitBoundsToWindow => ("FitB", vec![]),
        FitBoundsHorizontallyToWindow(y) => ("FitBH", vec![coordinate(y)]),
        FitBoundsVerticallyToWindow(x) => ("FitBV", vec![coordinate(x)]),
        Unknown | FitPageToWindow => ("Fit", vec![]),
    };
    let mut operands = vec![Object::Name(name.as_bytes().to_vec())];
    operands.extend(parameters);
    operands
}

// PDFium drops internal destinations during import; only its freshly saved output is patched.
pub(super) fn write_navigation(
    bytes: Vec<u8>,
    outline: &[OutlineNode],
    links: &[Vec<PageLink>],
    start: i32,
    cancelled: impl Fn() -> bool,
) -> Result<Option<Vec<u8>>, String> {
    if cancelled() {
        return Ok(None);
    }
    if outline.is_empty() && links.iter().all(Vec::is_empty) {
        return Ok(Some(bytes));
    }
    let mut document = Document::load_mem(&bytes)
        .map_err(|error| format!("could not reread the split PDF: {error}"))?;
    if !restore_links(&mut document, links, start, &cancelled)
        .map_err(|error| format!("could not restore the split PDF's links: {error}"))?
    {
        return Ok(None);
    }
    install_outline(&mut document, outline)?;
    let mut written = Vec::new();
    document
        .save_to(&mut written)
        .map_err(|error| format!("could not write the split PDF: {error}"))?;
    Ok((!cancelled()).then_some(written))
}

fn restore_links(
    document: &mut Document,
    links: &[Vec<PageLink>],
    start: i32,
    cancelled: &impl Fn() -> bool,
) -> Result<bool, lopdf::Error> {
    let pages: Vec<_> = document.get_pages().into_values().collect();
    for (page_index, page_links) in links.iter().enumerate() {
        if cancelled() {
            return Ok(false);
        }
        if page_links.is_empty() {
            continue;
        }
        let page_id = *pages
            .get(page_index)
            .ok_or(lopdf::Error::PageNumberNotFound(page_index as u32 + 1))?;
        let mut annotations = document
            .dereference(document.get_dictionary(page_id)?.get(b"Annots")?)?
            .1
            .as_array()?
            .clone();
        for link in page_links {
            // Import keeps annotation order; check the subtype before touching that copy.
            let annotation = annotations
                .get_mut(link.annotation)
                .ok_or(lopdf::Error::PageNumberNotFound(page_index as u32 + 1))?;
            let mut dictionary = document.dereference(annotation)?.1.as_dict()?.clone();
            if dictionary.get(b"Subtype")?.as_name()? != b"Link" {
                return Err(lopdf::Error::PageNumberNotFound(page_index as u32 + 1));
            }
            dictionary.remove(b"Dest");
            dictionary.remove(b"A");
            if let Some(target) = link
                .target
                .checked_sub(start)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| pages.get(index))
            {
                let mut destination = vec![Object::Reference(*target)];
                destination.extend(view_operands(link.view));
                dictionary.set("Dest", destination);
            }
            *annotation = Object::Reference(document.add_object(dictionary));
        }
        document
            .get_dictionary_mut(page_id)?
            .set("Annots", annotations);
    }
    Ok(!cancelled())
}
