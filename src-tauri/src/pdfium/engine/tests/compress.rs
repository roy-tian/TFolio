use super::support::*;
use super::*;
use crate::pdfium::compress::CompressionOptions;

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn compression_keeps_text_and_bookmarks() {
    let engine = test_engine();
    let directory = scratch_directory("compress-keeps");

    for (index, bytes) in [text_pdf(), outlined_three_page_pdf()]
        .into_iter()
        .enumerate()
    {
        let document = engine.open(bytes).unwrap();
        let expected_pages = {
            let documents = engine.lock_documents().unwrap();
            documents[&document.id].document.pages().len()
        };
        let destination = directory.join(format!("{index}.pdf"));
        assert!(engine
            .export_compressed(
                document.id,
                &destination,
                CompressionOptions {
                    image_dpi: Some(96),
                },
                |_, _| {}
            )
            .unwrap());
        // PDFium reopening the bytes is the check the format still holds.
        let reopened = engine.open(fs::read(&destination).unwrap()).unwrap();

        {
            let documents = engine.lock_documents().unwrap();
            let entry = &documents[&reopened.id];

            assert_eq!(entry.document.pages().len(), expected_pages);
            if index == 0 {
                let page = entry.document.pages().get(0).unwrap();
                assert!(page.text().unwrap().all().contains("Hello"));
            } else {
                assert_eq!(
                    collect_bookmark_siblings(entry.document.bookmarks().root())[0].title,
                    "Chapter"
                );
            }
        }

        engine.close(reopened.id).unwrap();
        engine.close(document.id).unwrap();
    }

    fs::remove_dir_all(directory).unwrap();
}

/// A one-page PDF whose single content is a large photograph-like JPEG, built
/// the way the app itself embeds images so the pass meets production bytes.
/// 900×700 pixels drawn 250×200 points is 252 dpi on the coarser axis — well
/// past any target, so 96 dpi resamples it to 343×267.
/// Smooth gradients are what JPEG encodes honestly: large at high quality,
/// far smaller downscaled and re-encoded lower.
fn jpeg_page_pdf() -> Vec<u8> {
    let engine = test_engine();
    // Held for the build's whole length: creating a document is PDFium work
    // under the store's lock like any other.
    let _documents = engine.documents.lock().unwrap();

    let mut gradient = image::RgbImage::new(900, 700);
    for (x, y, pixel) in gradient.enumerate_pixels_mut() {
        *pixel = image::Rgb([(x * 255 / 899) as u8, (y * 255 / 699) as u8, 128]);
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode_image(&DynamicImage::ImageRgb8(gradient))
        .unwrap();

    let mut document = engine.pdfium.create_new_pdf().unwrap();
    let mut page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::a4())
        .unwrap();
    let mut object =
        PdfPageImageObject::new_from_jpeg_reader(&document, Cursor::new(jpeg)).unwrap();
    object.scale(250.0, 200.0).unwrap();
    page.objects_mut().add_image_object(object).unwrap();
    page.regenerate_content().unwrap();
    drop(page);

    document.save_to_bytes().unwrap()
}

/// The sole image XObject's filter, pixel size and bytes, straight from the
/// object table — the pass's own view of what it did.
fn sole_image(bytes: &[u8]) -> (String, i64, i64, Vec<u8>) {
    let loaded = lopdf::Document::load_mem(bytes).unwrap();

    for object in loaded.objects.values() {
        let Ok(stream) = object.as_stream() else {
            continue;
        };
        let dict = &stream.dict;
        if !matches!(
            dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
            Some(b"Image")
        ) {
            continue;
        }

        let filter = dict
            .get(b"Filter")
            .ok()
            .and_then(|o| o.as_name().ok())
            .unwrap()
            .to_vec();
        let width = dict
            .get(b"Width")
            .ok()
            .and_then(|o| o.as_i64().ok())
            .unwrap();
        let height = dict
            .get(b"Height")
            .ok()
            .and_then(|o| o.as_i64().ok())
            .unwrap();

        return (
            String::from_utf8_lossy(&filter).into_owned(),
            width,
            height,
            stream.content.clone(),
        );
    }

    panic!("the document should hold an image");
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn image_compression_shrinks_the_photograph_and_announces_it() {
    let engine = test_engine();
    let directory = scratch_directory("compress-image");
    let source = jpeg_page_pdf();
    let document = engine.open(source.clone()).unwrap();
    let options = CompressionOptions {
        image_dpi: Some(96),
    };
    let mut announcements = Vec::new();
    let fresh = directory.join("fresh.pdf");
    let reused = directory.join("reused.pdf");

    // With nothing cached the export does the work, one step per image.
    assert!(engine
        .export_compressed(document.id, &fresh, options, |completed, total| {
            announcements.push((completed, total))
        })
        .unwrap());
    assert_eq!(announcements, [(0, 1), (1, 1)]);

    let estimate = engine
        .estimate_compression(document.id, options)
        .unwrap()
        .expect("an uncancelled estimate should answer");
    assert!(
        estimate.estimated_bytes < estimate.original_bytes,
        "a gradient resampled and re-encoded lower must be smaller: {} vs {}",
        estimate.estimated_bytes,
        estimate.original_bytes
    );

    // After the estimate the export writes the very bytes it measured, with
    // no work left to announce — and the fresh run made the same ones.
    announcements.clear();
    assert!(engine
        .export_compressed(document.id, &reused, options, |completed, total| {
            announcements.push((completed, total))
        })
        .unwrap());
    assert!(announcements.is_empty());

    let written = fs::read(&reused).unwrap();
    assert_eq!(written.len() as u64, estimate.estimated_bytes);
    assert_eq!(written, fs::read(&fresh).unwrap());

    let (_, width, height, _) = sole_image(&source);
    assert_eq!((width, height), (900, 700));
    let (filter, width, height, jpeg) = sole_image(&written);
    assert_eq!(filter, "DCTDecode");
    assert_eq!((width, height), (343, 267));
    // A JPEG stream, not something another stage re-compressed over.
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);

    // PDFium reopening the bytes is the check the format still holds, and the
    // photograph still draws.
    let reopened = engine.open(written).unwrap();
    assert!(rendered_darkness(engine, reopened.id, 1) > 0);

    engine.close(reopened.id).unwrap();
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

/// `bytes` with its sole image amended by `amend`, which receives that
/// image's object id.
fn amended(bytes: Vec<u8>, amend: impl FnOnce(&mut lopdf::Document, lopdf::ObjectId)) -> Vec<u8> {
    let mut loaded = lopdf::Document::load_mem(&bytes).unwrap();
    let photo = loaded
        .objects
        .iter()
        .find(|(_, object)| {
            object.as_stream().is_ok_and(|stream| {
                matches!(
                    stream
                        .dict
                        .get(b"Subtype")
                        .ok()
                        .and_then(|o| o.as_name().ok()),
                    Some(b"Image")
                )
            })
        })
        .map(|(id, _)| *id)
        .unwrap();

    amend(&mut loaded, photo);

    let mut saved = Vec::new();
    loaded.save_to(&mut saved).unwrap();
    saved
}

fn stream_dict(entries: &[(&str, lopdf::Object)]) -> lopdf::Dictionary {
    let mut dict = lopdf::Dictionary::new();
    for (key, value) in entries {
        dict.set(*key, value.clone());
    }
    dict
}

/// A flate-compressed 8-bit gray image of a noisy gradient: noise flate can
/// barely touch, so a resampled JPEG of it is far smaller.
fn noisy_gray_stream(width: u32, height: u32) -> lopdf::Stream {
    let mut seed = 0x2545_f491_u32;
    let mut samples = Vec::with_capacity((width * height) as usize);
    for _ in 0..height {
        for x in 0..width {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 24) as i32 % 32 - 16;
            samples.push(((x * 255 / (width - 1)) as i32 + noise).clamp(0, 255) as u8);
        }
    }

    let mut stream = lopdf::Stream::new(
        stream_dict(&[
            ("Type", "XObject".into()),
            ("Subtype", "Image".into()),
            ("Width", (width as i64).into()),
            ("Height", (height as i64).into()),
            ("ColorSpace", "DeviceGray".into()),
            ("BitsPerComponent", 8.into()),
        ]),
        samples,
    );
    stream.compress().unwrap();
    stream
}

/// Every image's filter and pixel size, sorted, straight from the object table.
fn image_shapes(bytes: &[u8]) -> Vec<(String, i64, i64)> {
    let loaded = lopdf::Document::load_mem(bytes).unwrap();
    let mut shapes: Vec<_> = loaded
        .objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .filter(|stream| {
            matches!(
                stream
                    .dict
                    .get(b"Subtype")
                    .ok()
                    .and_then(|o| o.as_name().ok()),
                Some(b"Image")
            )
        })
        .map(|stream| {
            let dict = &stream.dict;
            (
                String::from_utf8_lossy(dict.get(b"Filter").unwrap().as_name().unwrap())
                    .into_owned(),
                dict.get(b"Width").unwrap().as_i64().unwrap(),
                dict.get(b"Height").unwrap().as_i64().unwrap(),
            )
        })
        .collect();
    shapes.sort();
    shapes
}

fn export_at_96(engine: &PdfiumEngine, source: Vec<u8>, name: &str) -> Vec<u8> {
    let directory = scratch_directory(name);
    let document = engine.open(source).unwrap();
    let destination = directory.join("copy.pdf");

    assert!(engine
        .export_compressed(
            document.id,
            &destination,
            CompressionOptions {
                image_dpi: Some(96),
            },
            |_, _| {}
        )
        .unwrap());

    let written = fs::read(&destination).unwrap();
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
    written
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_soft_mask_keeps_its_samples() {
    let engine = test_engine();
    // The mask is also drawn on its own, so only being a mask can spare it;
    // its identical twin, drawn the same way and masking nothing, shrinks.
    let source = amended(jpeg_page_pdf(), |loaded, photo| {
        let mask = loaded.add_object(noisy_gray_stream(900, 700));
        let twin = loaded.add_object(noisy_gray_stream(900, 700));
        loaded
            .get_object_mut(photo)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .dict
            .set("SMask", lopdf::Object::Reference(mask));
        draw_at_photo_size(loaded, &[("TFolioMask", mask), ("TFolioTwin", twin)]);
    });

    let written = export_at_96(engine, source, "compress-mask");

    assert_eq!(
        image_shapes(&written),
        [
            ("DCTDecode".to_string(), 343, 267),
            ("DCTDecode".to_string(), 900, 700),
            ("FlateDecode".to_string(), 900, 700),
        ]
    );
}

/// Draws each named image on the first page at the photograph's 250×200
/// points, so each meets the same 252 dpi.
fn draw_at_photo_size(loaded: &mut lopdf::Document, images: &[(&str, lopdf::ObjectId)]) {
    let page = loaded.get_pages()[&1];
    let mut content = Vec::new();

    for (name, id) in images {
        loaded.add_xobject(page, *name, *id).unwrap();
        content.extend_from_slice(format!("q 250 0 0 200 0 0 cm /{name} Do Q\n").as_bytes());
    }

    loaded.add_page_contents(page, content).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_undrawn_image_keeps_its_pixels() {
    let engine = test_engine();
    // Reachable, so the rewrite keeps it, but drawn by no page: no resolution
    // to resample toward, so the pass must not guess one.
    let source = amended(jpeg_page_pdf(), |loaded, _| {
        let stray = loaded.add_object(noisy_gray_stream(900, 700));
        loaded
            .catalog_mut()
            .unwrap()
            .set("TFolioStray", lopdf::Object::Reference(stray));
    });

    let written = export_at_96(engine, source, "compress-undrawn");

    assert_eq!(
        image_shapes(&written),
        [
            ("DCTDecode".to_string(), 343, 267),
            ("FlateDecode".to_string(), 900, 700),
        ]
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_icc_image_keeps_its_bytes() {
    let engine = test_engine();
    let source = amended(jpeg_page_pdf(), |loaded, photo| {
        let profile = loaded.add_object(lopdf::Stream::new(
            stream_dict(&[("N", 3.into())]),
            vec![0; 128],
        ));
        loaded
            .get_object_mut(photo)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .dict
            .set(
                "ColorSpace",
                vec![
                    lopdf::Object::Name(b"ICCBased".to_vec()),
                    lopdf::Object::Reference(profile),
                ],
            );
    });

    let written = export_at_96(engine, source.clone(), "compress-icc");

    assert_eq!(sole_image(&source), sole_image(&written));
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn the_estimate_measures_against_the_opened_file_until_an_edit() {
    let engine = test_engine();
    // Trailing bytes PDFium's rewrite drops, so the two baselines differ.
    let mut source = two_page_pdf();
    source.extend_from_slice(b"\n%");
    source.extend(std::iter::repeat_n(b'x', 20_000));
    source.push(b'\n');
    let document = engine.open(source.clone()).unwrap();
    let full = CompressionOptions { image_dpi: None };

    let before = engine
        .estimate_compression(document.id, full)
        .unwrap()
        .unwrap();
    assert_eq!(before.original_bytes, source.len() as u64);

    engine.rotate_pages(document.id, &[1], 90).unwrap();

    let after = engine
        .estimate_compression(document.id, full)
        .unwrap()
        .unwrap();
    assert!(after.original_bytes + 10_000 < source.len() as u64);

    engine.close(document.id).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn keeping_original_images_leaves_their_bytes() {
    let engine = test_engine();
    let directory = scratch_directory("compress-full");
    let source = jpeg_page_pdf();
    let document = engine.open(source.clone()).unwrap();
    let destination = directory.join("copy.pdf");

    assert!(engine
        .export_compressed(
            document.id,
            &destination,
            CompressionOptions { image_dpi: None },
            |_, _| {}
        )
        .unwrap());

    // The structure-only endpoint's promise: the image keeps its very bytes.
    assert_eq!(
        sole_image(&source),
        sole_image(&fs::read(&destination).unwrap())
    );

    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn compression_estimates_report_both_sizes() {
    let engine = test_engine();
    let document = engine.open(two_page_pdf()).unwrap();

    for image_dpi in [None, Some(150)] {
        let estimate = engine
            .estimate_compression(document.id, CompressionOptions { image_dpi })
            .unwrap()
            .expect("an uncancelled estimate should answer");
        assert!(estimate.original_bytes > 0);
        assert!(estimate.estimated_bytes > 0);
    }

    engine.close(document.id).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_stopped_export_abandons_without_failing() {
    let engine = test_engine();
    let directory = scratch_directory("compress-stop");
    let document = engine.open(jpeg_page_pdf()).unwrap();
    let destination = directory.join("copy.pdf");
    let mut asked = false;

    // Cancelling from the progress callback stops the run between images —
    // the reader's own Stop button does exactly this through the command.
    let completed = engine
        .export_compressed(
            document.id,
            &destination,
            CompressionOptions {
                image_dpi: Some(96),
            },
            |completed, _total| {
                if completed == 0 && !asked {
                    asked = true;
                    engine.cancel_operation(OperationTarget::Compress(document.id));
                }
            },
        )
        .unwrap();

    assert!(
        !completed,
        "a reader-initiated stop abandons, it does not fail"
    );
    assert!(!destination.exists(), "an abandoned export leaves no file");

    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn compression_refuses_levels_out_of_bounds() {
    let engine = test_engine();
    let document = engine.open(two_page_pdf()).unwrap();
    let directory = scratch_directory("compress-bounds");
    let destination = directory.join("copy.pdf");

    for image_dpi in [0, 71, 301] {
        let levels = CompressionOptions {
            image_dpi: Some(image_dpi),
        };
        assert!(engine.estimate_compression(document.id, levels).is_err());
        assert!(engine
            .export_compressed(document.id, &destination, levels, |_, _| {})
            .is_err());
    }

    assert!(!destination.exists());
    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn a_compressed_copy_refuses_to_replace_an_open_pdf() {
    let engine = test_engine();
    let directory = scratch_directory("compress-refusal");
    let source = directory.join("source.pdf");
    fs::write(&source, text_pdf()).unwrap();
    let document = engine.open_from_path(source.clone()).unwrap();

    let refused = engine
        .export_compressed(
            document.id,
            &source,
            CompressionOptions { image_dpi: None },
            |_, _| {},
        )
        .unwrap_err();
    assert!(refused.contains("cannot replace an open PDF"));

    // The source's bytes are the refusal's promise: nothing was written.
    let before = fs::read(&source).unwrap();
    engine.close(document.id).unwrap();
    assert_eq!(fs::read(&source).unwrap(), before);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn an_edit_retires_the_cached_output() {
    let engine = test_engine();
    let directory = scratch_directory("compress-retired");
    let document = engine.open(jpeg_page_pdf()).unwrap();
    let destination = directory.join("copy.pdf");
    let options = CompressionOptions {
        image_dpi: Some(96),
    };

    engine
        .estimate_compression(document.id, options)
        .unwrap()
        .unwrap();
    engine.rotate_pages(document.id, &[1], 90).unwrap();
    assert!(engine
        .export_compressed(document.id, &destination, options, |_, _| {})
        .unwrap());

    // The estimate's bytes predate the turn; the copy must not.
    let written = lopdf::Document::load_mem(&fs::read(&destination).unwrap()).unwrap();
    let page = written.get_dictionary(written.get_pages()[&1]).unwrap();
    assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);

    engine.close(document.id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn releasing_drops_the_cached_copies() {
    let engine = test_engine();
    let document = engine.open(jpeg_page_pdf()).unwrap();

    engine
        .estimate_compression(document.id, CompressionOptions { image_dpi: None })
        .unwrap()
        .unwrap();
    assert!(engine.lock_documents().unwrap()[&document.id]
        .compress_cache
        .is_some());

    engine.release_compression(document.id).unwrap();
    assert!(engine.lock_documents().unwrap()[&document.id]
        .compress_cache
        .is_none());

    engine.close(document.id).unwrap();
}
