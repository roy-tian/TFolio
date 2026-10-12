use super::support::*;
use super::*;

// Dense bars inside (40,70)-(160,170): a high-frequency signal for mosaic and
// blur to reduce, with the untouched margin catching an effect placed wide.
fn striped_pdf_with_rotation(rotation: Option<i32>) -> Vec<u8> {
    let mut content = "0 0 0 rg\n".to_string();

    for left in (40..160).step_by(4) {
        content.push_str(&format!("{left} 130 2 100 re f\n"));
    }

    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    let rotation = rotation
        .map(|degrees| format!("/Rotate {degrees} "))
        .unwrap_or_default();
    let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] {rotation}/Contents 4 0 R >>\nendobj\n"
            ),
            contents_obj,
        ];

    build_pdf(&objects)
}

fn striped_pdf() -> Vec<u8> {
    striped_pdf_with_rotation(None)
}

fn rotated_striped_pdf() -> Vec<u8> {
    striped_pdf_with_rotation(Some(90))
}

// Four asymmetric colour fields: without them the target band alone cannot
// distinguish the two quarter-turn counter-rotations.
fn quadrant_pdf(rotation: i32) -> Vec<u8> {
    let content = concat!(
        "1 0 0 rg\n40 180 60 50 re f\n",
        "0 1 0 rg\n100 180 60 50 re f\n",
        "0 0 1 rg\n40 130 60 50 re f\n",
        "1 1 0 rg\n100 130 60 50 re f\n",
    );
    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );

    build_pdf(&[
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate {rotation} /Contents 4 0 R >>\nendobj\n"
            ),
            contents_obj,
        ])
}

fn a4_striped_pdf() -> Vec<u8> {
    let mut content = "0 0 0 rg\n".to_string();

    for left in (0..595).step_by(4) {
        content.push_str(&format!("{left} 0 2 842 re f\n"));
    }

    let contents_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{content}endstream\nendobj\n",
        content.len()
    );
    build_pdf(&[
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n".to_string(),
            contents_obj,
        ])
}

fn color_at_unrotated_point(image: &image::RgbImage, point: (f32, f32), rotation: i32) -> [u8; 3] {
    let (x, top) = point;
    let (displayed_x, displayed_y, displayed_width, displayed_height) = match rotation {
        90 => (300.0 - top, x, 300.0, 200.0),
        180 => (200.0 - x, 300.0 - top, 200.0, 300.0),
        270 => (top, 200.0 - x, 300.0, 200.0),
        _ => (x, top, 200.0, 300.0),
    };
    let pixel_x = ((displayed_x / displayed_width) * image.width() as f32)
        .floor()
        .clamp(0.0, image.width().saturating_sub(1) as f32) as u32;
    let pixel_y = ((displayed_y / displayed_height) * image.height() as f32)
        .floor()
        .clamp(0.0, image.height().saturating_sub(1) as f32) as u32;

    image.get_pixel(pixel_x, pixel_y).0
}

fn color_difference(actual: [u8; 3], expected: [u8; 3]) -> u16 {
    actual
        .into_iter()
        .zip(expected)
        .map(|(left, right)| left.abs_diff(right) as u16)
        .sum()
}

fn pixel_difference(
    before: &image::RgbImage,
    after: &image::RgbImage,
    band: (u32, u32, u32, u32),
) -> (u64, u64) {
    let (left, top, right, bottom) = band;
    let mut inside = 0;
    let mut outside = 0;

    for (x, y, pixel) in before.enumerate_pixels() {
        let next = after.get_pixel(x, y);
        let difference = pixel
            .0
            .into_iter()
            .zip(next.0)
            .map(|(a, b)| a.abs_diff(b) as u64)
            .sum::<u64>();

        if x >= left && x < right && y >= top && y < bottom {
            inside += difference;
        } else {
            outside += difference;
        }
    }

    (inside, outside)
}

fn horizontal_edge_energy(image: &image::RgbImage, band: (u32, u32, u32, u32)) -> u64 {
    let (left, top, right, bottom) = band;
    let mut energy = 0;

    for y in top..bottom {
        for x in (left + 1)..right {
            let previous = image.get_pixel(x - 1, y).0[0];
            let current = image.get_pixel(x, y).0[0];
            energy += previous.abs_diff(current) as u64;
        }
    }

    energy
}

fn luminance_variance(image: &image::RgbImage, band: (u32, u32, u32, u32)) -> f64 {
    let (left, top, right, bottom) = band;
    let mut values = Vec::new();

    for y in top..bottom {
        for x in left..right {
            let [red, green, blue] = image.get_pixel(x, y).0;
            values.push((red as f64 + green as f64 + blue as f64) / 3.0);
        }
    }

    let mean = values.iter().sum::<f64>() / values.len() as f64;
    values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64
}

#[test]
fn maps_unrotated_effect_bounds_into_the_rendered_page() {
    let bounds = quad(10.0, 20.0, 30.0, 40.0);

    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 0.0),
        DisplayRect {
            height: 40.0,
            left: 10.0,
            top: 20.0,
            width: 30.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 90.0),
        DisplayRect {
            height: 30.0,
            left: 240.0,
            top: 10.0,
            width: 40.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 180.0),
        DisplayRect {
            height: 40.0,
            left: 160.0,
            top: 240.0,
            width: 30.0,
        }
    );
    assert_eq!(
        rect_in_display_space(&bounds, 200.0, 300.0, 270.0),
        DisplayRect {
            height: 30.0,
            left: 20.0,
            top: 160.0,
            width: 40.0,
        }
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_changes_the_covered_pixels() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let band = (80, 140, 320, 340);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic");

    let after = rendered_rgb(engine, document.id);
    let (inside, outside) = pixel_difference(&before, &after, band);

    assert!(
        inside > 100_000,
        "the mosaic did not change its band: {inside}"
    );
    assert_eq!(outside, 0, "the mosaic changed pixels outside its band");

    delete_last_mark(engine, document.id, 1).expect("PDFium should remove the mosaic");
    assert_eq!(
        rendered_rgb(engine, document.id),
        before,
        "undoing the mosaic should restore every page pixel"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_lands_in_unrotated_space_on_a_rotated_page() {
    let engine = test_engine();
    let document = engine
        .open(rotated_striped_pdf())
        .expect("PDFium should open the rotated striped PDF");
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(40.0, 70.0, 120.0, 100.0),
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic in unrotated page space");

    // The unrotated box becomes (130,40)-(230,160) after `/Rotate 90`.
    // At 400px across the 300pt displayed width, this is the band below.
    let after = rendered_rgb(engine, document.id);
    let (inside, outside) = pixel_difference(&before, &after, (170, 50, 310, 217));

    assert!(
        inside > 100_000,
        "the rotated mosaic changed no source pixels"
    );
    assert_eq!(
        outside, 0,
        "the rotated mosaic landed outside its mapped band"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rectangle_effect_preserves_content_orientation_for_rotated_pages() {
    let engine = test_engine();
    let samples = [
        ((70.0, 95.0), [255, 0, 0]),
        ((130.0, 95.0), [0, 255, 0]),
        ((70.0, 145.0), [0, 0, 255]),
        ((130.0, 145.0), [255, 255, 0]),
    ];

    for rotation in [90, 180, 270] {
        let document = engine
            .open(quadrant_pdf(rotation))
            .expect("PDFium should open the quadrant PDF");
        let before = rendered_rgb(engine, document.id);

        engine
            .add_rect_effect(
                document.id,
                1,
                &quad(40.0, 70.0, 120.0, 100.0),
                &rect_effect(RectEffectKind::Mosaic, MIN_RECT_EFFECT_STRENGTH),
            )
            .expect("PDFium should add the rotated mosaic");

        let after = rendered_rgb(engine, document.id);

        for (point, expected) in samples {
            let before_color = color_at_unrotated_point(&before, point, rotation);
            let after_color = color_at_unrotated_point(&after, point, rotation);

            assert!(
                    color_difference(before_color, expected) < 10,
                    "rotation {rotation} fixture colour at {point:?} was {before_color:?}, expected {expected:?}"
                );
            assert!(
                color_difference(after_color, expected) < 20,
                "rotation {rotation} changed {point:?} to {after_color:?}, expected {expected:?}"
            );
        }
    }
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_makes_the_region_blocky() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let inner_band = (90, 150, 310, 330);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add the mosaic");

    let after = rendered_rgb(engine, document.id);
    let before_energy = horizontal_edge_energy(&before, inner_band);
    let after_energy = horizontal_edge_energy(&after, inner_band);

    assert!(
        after_energy < before_energy / 3,
        "mosaic blocks did not reduce local edge frequency: {before_energy} -> {after_energy}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn blur_reduces_local_variance() {
    let engine = test_engine();
    let document = engine
        .open(striped_pdf())
        .expect("PDFium should open the striped PDF");
    let bounds = quad(40.0, 70.0, 120.0, 100.0);
    let inner_band = (100, 160, 300, 320);
    let before = rendered_rgb(engine, document.id);

    engine
        .add_rect_effect(
            document.id,
            1,
            &bounds,
            &rect_effect(RectEffectKind::Blur, 8.0),
        )
        .expect("PDFium should add the blur");

    let after = rendered_rgb(engine, document.id);
    let before_variance = luminance_variance(&before, inner_band);
    let after_variance = luminance_variance(&after, inner_band);

    assert!(
        after_variance < before_variance / 2.0,
        "blur did not reduce local variance: {before_variance} -> {after_variance}"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn mosaic_does_not_remove_the_underlying_text() {
    let engine = test_engine();
    let document = engine
        .open(text_pdf())
        .expect("PDFium should open the text PDF");
    let before = engine
        .extract_text(document.id, 1)
        .expect("PDFium should extract the original text");
    assert!(before.iter().any(|span| span.text.contains("Hello")));

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(40.0, 25.0, 100.0, 50.0),
            &rect_effect(RectEffectKind::Mosaic, 12.0),
        )
        .expect("PDFium should add a mosaic over the text");

    let after = engine
        .extract_text(document.id, 1)
        .expect("PDFium should still extract text through the visual effect");
    assert!(
        after.iter().any(|span| span.text.contains("Hello")),
        "the underlying text must remain extractable"
    );
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn full_page_mosaic_keeps_the_file_size_bounded() {
    let engine = test_engine();
    let document = engine
        .open(a4_striped_pdf())
        .expect("PDFium should open the A4 striped PDF");

    engine
        .add_rect_effect(
            document.id,
            1,
            &quad(0.0, 0.0, 595.0, 842.0),
            &rect_effect(RectEffectKind::Mosaic, MIN_RECT_EFFECT_STRENGTH),
        )
        .expect("PDFium should mosaic the full page");

    let directory = scratch_directory("mosaic-size");
    let destination = directory.join("mosaic.pdf");
    engine
        .save_to(document.id, &destination)
        .expect("PDFium should save the mosaic");
    let size = fs::metadata(&destination)
        .expect("the saved mosaic should exist")
        .len();

    assert!(
        size < 10_000_000,
        "an A4 full-page mosaic grew to {size} bytes"
    );
    fs::remove_dir_all(&directory).ok();
}

#[test]
#[ignore = "requires `bun run pdfium:download`"]
fn rejects_an_unusable_rectangle_effect() {
    let engine = test_engine();
    let document = engine
        .open(minimal_pdf())
        .expect("PDFium should open the PDF");

    for result in [
        engine.add_rect_effect(
            document.id,
            1,
            &quad(10.0, 10.0, 40.0, 40.0),
            &rect_effect(RectEffectKind::Blur, 1.0),
        ),
        engine.add_rect_effect(
            document.id,
            1,
            &quad(190.0, 10.0, 40.0, 40.0),
            &rect_effect(RectEffectKind::Mosaic, 8.0),
        ),
        engine.add_rect_effect(
            document.id,
            1,
            &quad(10.0, 10.0, 0.0, 40.0),
            &rect_effect(RectEffectKind::Mosaic, 8.0),
        ),
    ] {
        assert!(result.is_err(), "an unusable effect should be rejected");
    }

    assert_eq!(
        with_page(engine, document.id, 1, |page| page.annotations().len()),
        0,
        "a refused effect should leave no annotation behind"
    );
}
