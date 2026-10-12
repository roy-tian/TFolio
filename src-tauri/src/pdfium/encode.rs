//! How rendered pages cross IPC: the WebView decodes them with
//! `createImageBitmap`, so they travel as an image format it reads.

use std::io::Cursor;

use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder, ImageFormat, RgbImage,
};

/// The one PNG encoder for page images. Sub-filtered with fast deflate it
/// measured about seven times faster than the adaptive default on scanned
/// pages at 1800 px, for about a fifth more bytes — a local IPC hop, where
/// time is what the reader waits on.
pub(super) fn encode_png(image: &RgbImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();

    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| error.to_string())?;

    Ok(png)
}

/// Thumbnails and the watermark preview.
pub(super) fn encode_webp(image: &RgbImage) -> Result<Vec<u8>, String> {
    let mut webp = Cursor::new(Vec::new());

    image
        .write_to(&mut webp, ImageFormat::WebP)
        .map_err(|error| error.to_string())?;

    Ok(webp.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RgbImage {
        RgbImage::from_fn(37, 23, |x, y| {
            image::Rgb([(x * 7) as u8, (y * 11) as u8, ((x + y) * 3) as u8])
        })
    }

    #[test]
    fn a_page_image_survives_the_encoder_unchanged() {
        let image = sample();

        let png = encode_png(&image).expect("the encoder should take an RGB page");
        let decoded = image::load_from_memory(&png)
            .expect("the PNG should decode")
            .into_rgb8();

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decoded, image);
    }

    #[test]
    fn a_thumbnail_survives_the_encoder_unchanged() {
        let image = sample();

        let webp = encode_webp(&image).expect("the encoder should take an RGB page");
        let decoded = image::load_from_memory(&webp)
            .expect("the WebP should decode")
            .into_rgb8();

        // RIFF container magic, with the four-byte file size in between.
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        // Lossless: the preview's pixels are the page's own.
        assert_eq!(decoded, image);
    }
}
