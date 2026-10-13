use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use super::super::image_dpi::image_dpis;

fn dict(entries: &[(&str, Object)]) -> Dictionary {
    let mut dict = Dictionary::new();
    for (key, value) in entries {
        dict.set(*key, value.clone());
    }
    dict
}

fn xobjects(entries: &[(&str, ObjectId)]) -> Dictionary {
    let xobjects = dict(
        &entries
            .iter()
            .map(|(name, id)| (*name, Object::Reference(*id)))
            .collect::<Vec<_>>(),
    );

    dict(&[("XObject", xobjects.into())])
}

/// Samples are never read: the walk needs only the declared size.
fn image(document: &mut Document, width: i64, height: i64) -> ObjectId {
    document.add_object(Stream::new(
        dict(&[
            ("Type", "XObject".into()),
            ("Subtype", "Image".into()),
            ("Width", width.into()),
            ("Height", height.into()),
            ("ColorSpace", "DeviceGray".into()),
            ("BitsPerComponent", 8.into()),
        ]),
        Vec::new(),
    ))
}

fn form(
    document: &mut Document,
    id: ObjectId,
    content: &str,
    matrix: Option<[f32; 6]>,
    resources: Option<Dictionary>,
) {
    let mut entries = vec![
        ("Type", "XObject".into()),
        ("Subtype", "Form".into()),
        (
            "BBox",
            vec![0.into(), 0.into(), 1000.into(), 1000.into()].into(),
        ),
    ];
    if let Some(matrix) = matrix {
        entries.push((
            "Matrix",
            matrix
                .iter()
                .map(|&value| value.into())
                .collect::<Vec<Object>>()
                .into(),
        ));
    }
    if let Some(resources) = resources {
        entries.push(("Resources", resources.into()));
    }

    document.objects.insert(
        id,
        Stream::new(dict(&entries), content.as_bytes().to_vec()).into(),
    );
}

/// One page drawing `content`, its resources on the page itself or, where
/// `inherited`, on the page tree node above it.
fn single_page(document: &mut Document, content: &str, resources: Dictionary, inherited: bool) {
    let pages = document.new_object_id();
    let contents = document.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
    let mut page = vec![
        ("Type", "Page".into()),
        ("Parent", Object::Reference(pages)),
        (
            "MediaBox",
            vec![0.into(), 0.into(), 612.into(), 792.into()].into(),
        ),
        ("Contents", Object::Reference(contents)),
    ];
    let mut tree = vec![("Type", "Pages".into()), ("Count", 1.into())];
    if inherited {
        tree.push(("Resources", resources.into()));
    } else {
        page.push(("Resources", resources.into()));
    }
    let page = document.add_object(dict(&page));
    tree.push(("Kids", vec![Object::Reference(page)].into()));
    document.objects.insert(pages, dict(&tree).into());

    let catalog = document.add_object(dict(&[
        ("Type", "Catalog".into()),
        ("Pages", Object::Reference(pages)),
    ]));
    document.trailer.set("Root", Object::Reference(catalog));
}

fn measured(document: &Document) -> std::collections::HashMap<ObjectId, f32> {
    image_dpis(document, &|| false).unwrap()
}

#[test]
fn an_image_drawn_twice_keeps_its_largest_drawing() {
    let mut document = Document::with_version("1.7");
    let image = image(&mut document, 720, 720);
    single_page(
        &mut document,
        "q 72 0 0 72 0 0 cm /Im Do Q q 360 0 0 360 0 0 cm /Im Do Q",
        xobjects(&[("Im", image)]),
        false,
    );

    // 720 dpi at one inch, 144 at five: the five-inch drawing needs the pixels.
    assert_eq!(measured(&document)[&image], 144.0);
}

#[test]
fn a_form_composes_its_matrix_after_the_state_it_inherits() {
    let mut document = Document::with_version("1.7");
    let image = image(&mut document, 720, 720);
    let fm = document.new_object_id();
    // No resources of its own: the form borrows the page's to find the image.
    form(
        &mut document,
        fm,
        "q 72 0 0 72 0 0 cm /Im Do Q",
        Some([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]),
        None,
    );
    // The first scale is saved and restored away, so it must not count.
    single_page(
        &mut document,
        "q 0.5 0 0 0.5 0 0 cm Q q 3 0 0 3 0 0 cm /Fm Do Q",
        xobjects(&[("Im", image), ("Fm", fm)]),
        false,
    );

    // 72 × 2 × 3 = 432 points: six inches for 720 pixels.
    assert_eq!(measured(&document)[&image], 120.0);
}

#[test]
fn a_rotated_stretched_image_answers_for_its_coarser_axis() {
    let mut document = Document::with_version("1.7");
    let image = image(&mut document, 720, 360);
    // A quarter turn: the image's width runs up the page 144 points, its
    // height across 144 points.
    single_page(
        &mut document,
        "q 0 144 -144 0 144 0 cm /Im Do Q",
        xobjects(&[("Im", image)]),
        false,
    );

    // 720 pixels over two inches is 360 dpi, 360 over two is 180.
    assert_eq!(measured(&document)[&image], 180.0);
}

#[test]
fn inherited_resources_resolve_and_undrawn_images_stay_unmeasured() {
    let mut document = Document::with_version("1.7");
    let drawn = image(&mut document, 720, 720);
    let undrawn = image(&mut document, 720, 720);
    single_page(
        &mut document,
        "q 360 0 0 360 0 0 cm /Im Do Q",
        xobjects(&[("Im", drawn), ("Spare", undrawn)]),
        true,
    );

    let dpis = measured(&document);

    assert_eq!(dpis[&drawn], 144.0);
    assert!(!dpis.contains_key(&undrawn));
}

#[test]
fn a_form_that_draws_itself_ends() {
    let mut document = Document::with_version("1.7");
    let image = image(&mut document, 720, 720);
    let fm = document.new_object_id();
    form(
        &mut document,
        fm,
        "q 72 0 0 72 0 0 cm /Im Do Q /Fm Do",
        None,
        Some(xobjects(&[("Im", image), ("Fm", fm)])),
    );
    single_page(&mut document, "/Fm Do", xobjects(&[("Fm", fm)]), false);

    assert_eq!(measured(&document)[&image], 720.0);
}

#[test]
fn a_stop_between_pages_answers_nothing() {
    let mut document = Document::with_version("1.7");
    let image = image(&mut document, 720, 720);
    single_page(&mut document, "/Im Do", xobjects(&[("Im", image)]), false);

    assert!(image_dpis(&document, &|| true).is_none());
}
