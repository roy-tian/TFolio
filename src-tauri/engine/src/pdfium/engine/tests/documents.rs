use super::support::*;
use super::*;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn opens_and_renders_pdf_with_pdfium() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    assert_eq!(document.num_pages, 1);
    assert_eq!(document.pages.len(), 1);

    let page = engine
        .render_page(document.id, 1, 400)
        .expect("PDFium should render the page");
    // 200 × 300 points, scaled to the width asked for.
    assert_eq!(page.dimensions(), (400, 600));
    // Blank, so all of it is the white every page renders onto.
    assert!(page.pixels().all(|pixel| pixel.0 == [255, 255, 255]));

    // The minimal PDF carries no page content, so it has no selectable text.
    let spans = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract text");
    assert!(spans.is_empty());
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn renders_thumbnail_within_its_cap() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");
    let thumbnail = engine
        .render_thumbnail(document.id, 1, 200)
        .expect("PDFium should render the thumbnail");

    assert_eq!(thumbnail.dimensions(), (200, 300));

    let error = engine
        .render_thumbnail(document.id, 1, MAX_THUMBNAIL_WIDTH + 1)
        .expect_err("thumbnails wider than the cap are rejected");
    assert!(error.contains("render width must be between"));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn creates_a_blank_a4_document_with_no_file_of_its_own() {
    let engine = test_engine();
    let document = engine
        .create_blank()
        .expect("PDFium should create a blank document");

    assert_eq!(document.num_pages, 1);

    let page = &document.pages[0];
    assert!(
        (page.width - 595.0).abs() < 1.0 && (page.height - 842.0).abs() < 1.0,
        "the page should be A4, and was {}x{}",
        page.width,
        page.height
    );
    // Nothing to overwrite: the document never came from a file, so the save
    // key stays down until an export gives it one.
    assert!(document.path.is_none());

    engine
        .close(document.id)
        .expect("the new document should close");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn opens_a_converted_source_with_no_file_of_its_own() {
    let engine = test_engine();
    let directory = scratch_directory("open-converted");
    let image_path = directory.join("pixel.png");

    image::RgbaImage::from_pixel(40, 30, image::Rgba([12, 120, 200, 255]))
        .save_with_format(&image_path, image::ImageFormat::Png)
        .expect("the test image should save");

    let document = engine
        .open_converted("main", image_path.clone())
        .expect("the image should open as its converted PDF");

    assert_eq!(document.num_pages, 1);

    let page = &document.pages[0];
    // The landscape pixels lie on a turned A4 sheet, exactly as the merge
    // lays the same image.
    assert!(
        (page.width - 842.0).abs() < 1.0 && (page.height - 595.0).abs() < 1.0,
        "the page should be turned A4, and was {}x{}",
        page.width,
        page.height
    );
    assert!(document.path.is_none());

    engine
        .close(document.id)
        .expect("the converted document should close");

    // A Word source with nowhere to stage a conversion is a refusal naming
    // the file, never a crash.
    let word_path = directory.join("notes.docx");
    std::fs::write(&word_path, b"not really a Word document")
        .expect("the fake Word document should save");

    let refused = engine
        .open_converted("main", word_path.clone())
        .expect_err("the Word document should refuse to convert");
    assert!(refused.contains("could not be converted"));

    let other = engine
        .open_converted("main", directory.join("archive.zip"))
        .expect_err("a non-source extension is not the command's to take");
    assert!(other.contains("not a convertible source"));

    let _ = std::fs::remove_dir_all(directory);
}

fn sole_pdf_image(bytes: &[u8]) -> (String, bool, Vec<u8>) {
    let loaded = lopdf::Document::load_mem(bytes).unwrap();
    let mut found = None;
    for object in loaded.objects.values() {
        let Ok(stream) = object.as_stream() else {
            continue;
        };
        if matches!(
            stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|o| o.as_name().ok()),
            Some(b"Image")
        ) {
            let filter = stream
                .dict
                .get(b"Filter")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|name| String::from_utf8_lossy(name).into_owned())
                .unwrap_or_default();
            let has_smask = stream.dict.has(b"SMask");
            assert!(found.is_none(), "expected a single image object in the PDF");
            found = Some((filter, has_smask, stream.content.clone()));
        }
    }

    found.expect("the PDF should hold an image")
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn image_import_embeds_jpegs_and_photos_as_dct_while_keeping_crisp_pngs_lossless() {
    let engine = test_engine();
    let directory = scratch_directory("image-import-format");

    // 1. A baseline JPEG passes through directly as DCTDecode without re-encoding.
    let mut gradient = image::RgbImage::new(320, 240);
    for (x, y, pixel) in gradient.enumerate_pixels_mut() {
        *pixel = image::Rgb([(x * 255 / 319) as u8, (y * 255 / 239) as u8, 128]);
    }
    let mut original_jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut original_jpeg, 85)
        .encode_image(&DynamicImage::ImageRgb8(gradient))
        .unwrap();
    let jpg_path = directory.join("photo.jpg");
    std::fs::write(&jpg_path, &original_jpeg).unwrap();

    let jpg_doc = engine.open_converted("main", jpg_path).unwrap();
    let jpg_pdf = {
        let documents = engine.lock_documents().unwrap();
        documents[&jpg_doc.id].document.save_to_bytes().unwrap()
    };
    let (filter, has_smask, embedded) = sole_pdf_image(&jpg_pdf);
    assert_eq!(filter, "DCTDecode");
    assert!(!has_smask);
    assert_eq!(embedded, original_jpeg);
    engine.close(jpg_doc.id).unwrap();

    // 2. A photographic RGBA PNG with transparent margins composites onto white
    //    and converts to DCTDecode (no /SMask, far smaller than raw FlateDecode).
    let mut seed = 0x517c_c1b7_u32;
    let mut photo_png = image::RgbaImage::new(400, 300);
    for (x, y, pixel) in photo_png.enumerate_pixels_mut() {
        if !(60..340).contains(&x) {
            *pixel = image::Rgba([0, 0, 0, 0]);
        } else {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 24) as i32 % 48 - 24;
            let r = ((x * 255 / 399) as i32 + noise).clamp(0, 255) as u8;
            let g = ((y * 255 / 299) as i32 - noise).clamp(0, 255) as u8;
            let b = (140 + noise).clamp(0, 255) as u8;
            *pixel = image::Rgba([r, g, b, 255]);
        }
    }
    let photo_png_path = directory.join("cutout-photo.png");
    photo_png
        .save_with_format(&photo_png_path, image::ImageFormat::Png)
        .unwrap();

    let png_doc = engine.open_converted("main", photo_png_path).unwrap();
    let png_pdf = {
        let documents = engine.lock_documents().unwrap();
        documents[&png_doc.id].document.save_to_bytes().unwrap()
    };
    let (filter, has_smask, embedded) = sole_pdf_image(&png_pdf);
    assert_eq!(filter, "DCTDecode");
    assert!(!has_smask);
    assert_eq!(&embedded[..2], &[0xFF, 0xD8]);
    let rendered = engine.render_page(png_doc.id, 1, 400).unwrap();
    // Transparent left margin composited onto white, centre holds the photograph.
    assert_eq!(
        rendered.get_pixel(10, rendered.height() / 2).0,
        [255, 255, 255]
    );
    assert!(rendered_darkness(engine, png_doc.id, 1) > 0);
    engine.close(png_doc.id).unwrap();

    // 3. A crisp flat graphic / UI-like PNG stays lossless FlateDecode.
    let mut graphic = image::RgbImage::from_pixel(400, 300, image::Rgb([255, 255, 255]));
    for y in (20..280).step_by(24) {
        for x in 20..380 {
            graphic.put_pixel(x, y, image::Rgb([20, 20, 20]));
            graphic.put_pixel(x, y + 1, image::Rgb([20, 20, 20]));
        }
    }
    let graphic_path = directory.join("diagram.png");
    graphic
        .save_with_format(&graphic_path, image::ImageFormat::Png)
        .unwrap();

    let graphic_doc = engine.open_converted("main", graphic_path).unwrap();
    let graphic_pdf = {
        let documents = engine.lock_documents().unwrap();
        documents[&graphic_doc.id].document.save_to_bytes().unwrap()
    };
    let (filter, has_smask, _) = sole_pdf_image(&graphic_pdf);
    assert_eq!(filter, "FlateDecode");
    assert!(!has_smask);
    engine.close(graphic_doc.id).unwrap();

    let _ = std::fs::remove_dir_all(directory);
}
