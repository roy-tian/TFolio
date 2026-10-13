//! A page's pixels leave PDFium as a plain copy of its buffer, taken under the
//! documents lock; converting them waits until it is released, and encoding
//! them for the screen is the host's.

use image::RgbImage;
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

        // A zero size would panic in `chunks_exact`, and release aborts on panic.
        if width == 0 || stride < width * channels {
            return Err("PDFium's bitmap is empty or smaller than its size".into());
        }

        let mut rgb = vec![0; width * height * 3];
        let rows = rgb
            .chunks_exact_mut(width * 3)
            .zip(self.bytes.chunks_exact(stride));

        // Matched once, not per pixel: pushing pixel by pixel measured about
        // four times slower, 27 ms against 7 for an 1800 px page.
        match channels {
            1 => rows.for_each(|(out, row)| {
                for (pixel, &gray) in out.chunks_exact_mut(3).zip(&row[..width]) {
                    pixel.fill(gray);
                }
            }),
            3 => rows.for_each(|(out, row)| out.copy_from_slice(&row[..width * 3])),
            _ => rows.for_each(|(out, row)| {
                for (pixel, source) in out.chunks_exact_mut(3).zip(row.chunks_exact(4)) {
                    pixel.copy_from_slice(&source[..3]);
                }
            }),
        }

        RgbImage::from_raw(self.width, self.height, rgb)
            .ok_or_else(|| "PDFium's bitmap did not fill its size".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn padded_three_channel_rows_drop_their_padding() {
        // One pixel a row, padded to the four-byte boundary PDFium aligns to.
        let bitmap = RawBitmap {
            bytes: vec![1, 2, 3, 0, 4, 5, 6, 0],
            width: 1,
            height: 2,
            format: PdfBitmapFormat::BGR,
        };

        assert_eq!(
            bitmap
                .into_rgb()
                .expect("a padded bitmap converts")
                .into_raw(),
            vec![1, 2, 3, 4, 5, 6]
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
