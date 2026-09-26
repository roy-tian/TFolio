//! A page's pixels leave PDFium as a plain copy of its buffer, taken under the
//! documents lock; converting and encoding them waits until it is released.

use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder, RgbImage,
};
use pdfium_render::prelude::*;

pub(super) struct RawBitmap {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    format: PdfBitmapFormat,
}

impl RawBitmap {
    /// A memcpy, and nothing else, while the caller holds the lock.
    pub(super) fn copy_of(bitmap: &PdfBitmap) -> Result<Self, String> {
        Ok(Self {
            bytes: bitmap.as_raw_bytes(),
            width: bitmap.width() as u32,
            height: bitmap.height() as u32,
            format: bitmap
                .format()
                .map_err(|error| format!("PDFium reported no pixel format: {error}"))?,
        })
    }

    /// Every page renders onto opaque white, so alpha carries nothing. The
    /// channels are in RGB order, as `set_reverse_byte_order(true)` has PDFium
    /// write them. Rows may be padded past their pixels: the stride is the
    /// buffer's own.
    pub(super) fn into_rgb(self) -> Result<RgbImage, String> {
        let (width, height) = (self.width as usize, self.height as usize);
        let channels = match self.format {
            PdfBitmapFormat::Gray => 1,
            PdfBitmapFormat::BGR => 3,
            PdfBitmapFormat::BGRx | PdfBitmapFormat::BGRA => 4,
        };
        let stride = self.bytes.len().checked_div(height).unwrap_or(0);

        // A zero stride would panic in `chunks_exact`, and release aborts on panic.
        if stride == 0 || stride < width * channels {
            return Err("PDFium's bitmap is smaller than its size".into());
        }

        let mut rgb = Vec::with_capacity(width * height * 3);

        for row in self.bytes.chunks_exact(stride).take(height) {
            for pixel in row[..width * channels].chunks_exact(channels) {
                match channels {
                    1 => rgb.extend_from_slice(&[pixel[0], pixel[0], pixel[0]]),
                    _ => rgb.extend_from_slice(&pixel[..3]),
                }
            }
        }

        RgbImage::from_raw(self.width, self.height, rgb)
            .ok_or_else(|| "PDFium's bitmap did not fill its size".to_string())
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_image_survives_the_encoder_unchanged() {
        let image = RgbImage::from_fn(37, 23, |x, y| {
            image::Rgb([(x * 7) as u8, (y * 11) as u8, ((x + y) * 3) as u8])
        });

        let png = encode_png(&image).expect("the encoder should take an RGB page");
        let decoded = image::load_from_memory(&png)
            .expect("the PNG should decode")
            .into_rgb8();

        assert_eq!(decoded, image);
    }

    #[test]
    fn padded_four_channel_rows_come_out_as_rgb() {
        // Two pixels a row, padded to twelve bytes as PDFium may align them.
        let bitmap = RawBitmap {
            bytes: vec![
                1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 0, //
                7, 8, 9, 255, 10, 11, 12, 255, 0, 0, 0, 0,
            ],
            width: 2,
            height: 2,
            format: PdfBitmapFormat::BGRA,
        };

        assert_eq!(
            bitmap
                .into_rgb()
                .expect("a padded bitmap converts")
                .into_raw(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        );
    }

    #[test]
    fn a_gray_bitmap_comes_out_as_rgb() {
        let bitmap = RawBitmap {
            bytes: vec![10, 20, 30, 40],
            width: 2,
            height: 2,
            format: PdfBitmapFormat::Gray,
        };

        assert_eq!(
            bitmap
                .into_rgb()
                .expect("a gray bitmap converts")
                .into_raw(),
            vec![10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]
        );
    }
}
