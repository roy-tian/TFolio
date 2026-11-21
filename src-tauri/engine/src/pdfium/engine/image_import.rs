use super::*;

// An image is read whole before it is decoded, and a photograph is nothing
// like a document in size, so its ceiling sits well under the PDF one.
pub(super) const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

// An A4 page scanned at 600dpi is about 35 megapixels: generous room above
// real input while refusing a header claiming a bitmap no machine could hold.
pub(super) const MAX_IMAGE_PIXELS: u64 = 80_000_000;

// High enough that photographic PNG/WebP/BMP imports stay virtually lossless
// while avoiding the 10x bloat of raw FlateDecode bitmaps.
const IMPORT_JPEG_QUALITY: u8 = 90;

// Tiny icons and dividers stay lossless on import.
const MIN_IMPORT_JPEG_PIXELS: u64 = 16_384;

// Only convert a lossless source to JPEG on import when JPEG is at most half
// the FlateDecode size: photos hit 5-20%, while crisp UI/text PNGs stay lossless.
const IMPORT_JPEG_MAX_FLATE_PERCENT: u64 = 50;

pub fn is_merge_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MERGE_IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

pub(super) fn image_limit_error() -> String {
    format!(
        "image file exceeds the {} MiB limit",
        MAX_IMAGE_BYTES / 1024 / 1024
    )
}

/// An image decoded and prepared off the PDFium lock for `image_page_document`.
pub(super) enum PreparedImage {
    /// Baseline RGB/Gray JPEG ready to embed directly via `DCTDecode`.
    Jpeg {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    },
    /// Opaque RGB/Gray bitmap embedded via `FlateDecode` for small images or
    /// crisp graphics where lossless encoding stays compact.
    Bitmap(DynamicImage),
}

impl PreparedImage {
    pub(super) fn dimensions(&self) -> (u32, u32) {
        match self {
            Self::Jpeg { width, height, .. } => (*width, *height),
            Self::Bitmap(image) => (image.width(), image.height()),
        }
    }

    /// Rough memory footprint once loaded into PDFium, for the open-source budget.
    pub(super) fn estimated_bytes(&self) -> usize {
        match self {
            Self::Jpeg { bytes, .. } => bytes.len(),
            Self::Bitmap(image) => image.width() as usize * image.height() as usize * 4,
        }
    }
}

/// True when `bytes` is a standard 8-bit 1- or 3-channel baseline DCT JPEG
/// (SOF0) without an Adobe raw-RGB APP14 transform that PDFium's inline JPEG
/// loader would misinterpret as YCbCr.
fn is_safe_passthrough_jpeg(bytes: &[u8]) -> bool {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return false;
    }

    let mut pos = 2;
    let mut saw_sof0 = false;

    while pos < bytes.len() {
        while pos < bytes.len() && bytes[pos] != 0xFF {
            pos += 1;
        }
        while pos < bytes.len() && bytes[pos] == 0xFF {
            pos += 1;
        }
        if pos >= bytes.len() {
            return false;
        }

        let marker = bytes[pos];
        pos += 1;

        // Standalone markers carry no length field.
        if marker == 0x00 || marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            continue;
        }
        // Start of Scan / End of Image ends the frame headers.
        if marker == 0xDA || marker == 0xD9 {
            return saw_sof0;
        }

        if pos + 2 > bytes.len() {
            return false;
        }
        let length = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if length < 2 || pos + length > bytes.len() {
            return false;
        }
        let body = &bytes[pos + 2..pos + length];
        pos += length;

        match marker {
            // SOF0: Baseline DCT — require 8-bit Grayscale (1) or YCbCr (3).
            0xC0 => {
                if body.len() < 6 || body[0] != 8 || !matches!(body[5], 1 | 3) {
                    return false;
                }
                saw_sof0 = true;
            }
            // Any other SOF (extended, progressive, lossless, arithmetic, etc.)
            // re-encodes to baseline so every PDF viewer reads it uniformly.
            0xC1..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return false,
            // APP14 Adobe marker: colour transform 0 on 3-channel data means
            // un-transformed RGB rather than YCbCr.
            0xEE if body.len() >= 12 && &body[..5] == b"Adobe" && body[11] == 0 => {
                return false;
            }
            _ => {}
        }
    }

    false
}

/// Blends an alpha channel onto white paper and normalizes to 8-bit Gray or
/// RGB: an imported image sits alone on a blank white A4 sheet, so compositing
/// matches what every viewer paints without emitting a separate `/SMask`.
fn composite_onto_white(image: DynamicImage) -> DynamicImage {
    match image {
        image @ (DynamicImage::ImageLuma8(_) | DynamicImage::ImageRgb8(_)) => image,
        DynamicImage::ImageLuma16(_) => DynamicImage::ImageLuma8(image.to_luma8()),
        DynamicImage::ImageLumaA8(luma_a) => {
            let (width, height) = luma_a.dimensions();
            let mut out = Vec::with_capacity((width as usize) * (height as usize));
            for pixel in luma_a.pixels() {
                let [l, a] = pixel.0;
                let a = u32::from(a);
                let blended = (u32::from(l) * a + 255 * (255 - a) + 127) / 255;
                out.push(blended as u8);
            }
            DynamicImage::ImageLuma8(
                image::GrayImage::from_raw(width, height, out)
                    .expect("composited gray buffer matches dimensions"),
            )
        }
        DynamicImage::ImageLumaA16(_) => {
            composite_onto_white(DynamicImage::ImageLumaA8(image.to_luma_alpha8()))
        }
        image if image.color().has_alpha() => {
            let rgba = image.to_rgba8();
            let (width, height) = rgba.dimensions();
            let mut out = Vec::with_capacity((width as usize) * (height as usize) * 3);
            for pixel in rgba.pixels() {
                let [r, g, b, a] = pixel.0;
                let a = u32::from(a);
                let inv = 255 * (255 - a);
                out.push(((u32::from(r) * a + inv + 127) / 255) as u8);
                out.push(((u32::from(g) * a + inv + 127) / 255) as u8);
                out.push(((u32::from(b) * a + inv + 127) / 255) as u8);
            }
            DynamicImage::ImageRgb8(
                RgbImage::from_raw(width, height, out)
                    .expect("composited RGB buffer matches dimensions"),
            )
        }
        image => DynamicImage::ImageRgb8(image.to_rgb8()),
    }
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(image)
        .map_err(|error| format!("image could not be encoded as JPEG: {error}"))?;
    Ok(jpeg)
}

struct CountingWriter(usize);

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn flate_size(samples: &[u8]) -> Option<usize> {
    let mut encoder =
        flate2::write::ZlibEncoder::new(CountingWriter(0), flate2::Compression::fast());
    encoder.write_all(samples).ok()?;
    encoder.finish().ok().map(|counter| counter.0)
}

/// Decodes `path` under both ceilings and chooses whether to embed it as JPEG
/// or lossless bitmap. The format comes from the bytes, not the extension: a
/// mislabelled file is a decode error, not a hazard.
pub(super) fn read_image(path: &Path) -> Result<PreparedImage, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;

    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }

    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(image_limit_error());
    }

    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(image_limit_error());
    }

    let mut limits = image::Limits::default();

    limits.max_alloc = Some(MAX_IMAGE_PIXELS * 4);

    let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let format = reader.format();

    reader.limits(limits);

    let unusable =
        |error: image::ImageError| format!("{} is not a usable image: {error}", path.display());
    let mut decoder = reader.into_decoder().map_err(unusable)?;
    let (width, height) = decoder.dimensions();

    // Off the header, before a pixel is allocated: `max_alloc` is documented as
    // non-strict, so the size a file claims must refuse the bitmap itself.
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
        || decoder.total_bytes() > MAX_IMAGE_PIXELS * 4
    {
        return Err(image_limit_error());
    }

    // Cameras record orientation in metadata, not pixels; without this a
    // portrait photograph arrives landscape and lands sideways on the sheet.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(unusable)?;

    if format == Some(image::ImageFormat::Jpeg) {
        if orientation == Orientation::NoTransforms
            && matches!(
                image,
                DynamicImage::ImageRgb8(_) | DynamicImage::ImageLuma8(_)
            )
            && is_safe_passthrough_jpeg(&bytes)
        {
            return Ok(PreparedImage::Jpeg {
                bytes,
                width,
                height,
            });
        }

        image.apply_orientation(orientation);
        let flat = composite_onto_white(image);
        let (width, height) = (flat.width(), flat.height());
        let jpeg = encode_jpeg(&flat, IMPORT_JPEG_QUALITY)?;

        return Ok(PreparedImage::Jpeg {
            bytes: jpeg,
            width,
            height,
        });
    }

    image.apply_orientation(orientation);
    let flat = composite_onto_white(image);
    let (width, height) = (flat.width(), flat.height());

    if u64::from(width) * u64::from(height) >= MIN_IMPORT_JPEG_PIXELS {
        if let (Some(flate_len), Ok(jpeg)) = (
            flate_size(flat.as_bytes()),
            encode_jpeg(&flat, IMPORT_JPEG_QUALITY),
        ) {
            if (jpeg.len() as u64) * 100 <= (flate_len as u64) * IMPORT_JPEG_MAX_FLATE_PERCENT {
                return Ok(PreparedImage::Jpeg {
                    bytes: jpeg,
                    width,
                    height,
                });
            }
        }
    }

    Ok(PreparedImage::Bitmap(flat))
}

/// Builds an opaque `PdfPageImageObject` using `Gray` or `BGRx` instead of
/// `pdfium-render`'s `BGRA` path, which otherwise attaches an all-opaque
/// `/SMask` stream to every imported bitmap.
fn opaque_bitmap_image_object<'a>(
    document: &PdfDocument<'a>,
    image: &DynamicImage,
    width: f32,
    height: f32,
    path: &Path,
) -> Result<PdfPageImageObject<'a>, String> {
    let pixel_width: Pixels = image
        .width()
        .try_into()
        .map_err(|_| format!("{} exceeds PDFium image size bounds", path.display()))?;
    let pixel_height: Pixels = image
        .height()
        .try_into()
        .map_err(|_| format!("{} exceeds PDFium image size bounds", path.display()))?;
    let placeholder = DynamicImage::new_rgb8(1, 1);
    let mut object = PdfPageImageObject::new_with_size(
        document,
        &placeholder,
        PdfPoints::new(width),
        PdfPoints::new(height),
    )
    .map_err(|error| format!("PDFium could not place {}: {error}", path.display()))?;

    let (format, mut buffer) = match image {
        DynamicImage::ImageLuma8(gray) => {
            let row_bytes = gray.width() as usize;
            let stride = row_bytes.div_ceil(4) * 4;
            let mut buf = vec![0u8; stride * gray.height() as usize];
            for (y, row) in gray.as_raw().chunks_exact(row_bytes).enumerate() {
                buf[y * stride..y * stride + row_bytes].copy_from_slice(row);
            }
            (PdfBitmapFormat::Gray, buf)
        }
        _ => {
            let rgb = image.to_rgb8();
            let mut buf = Vec::with_capacity((rgb.width() as usize) * (rgb.height() as usize) * 4);
            for pixel in rgb.pixels() {
                let [r, g, b] = pixel.0;
                buf.extend_from_slice(&[b, g, r, 255]);
            }
            (PdfBitmapFormat::BGRx, buf)
        }
    };

    let bitmap = PdfBitmap::from_bytes(pixel_width, pixel_height, format, &mut buffer)
        .map_err(|error| format!("PDFium could not prepare {}: {error}", path.display()))?;
    object
        .set_bitmap(&bitmap)
        .map_err(|error| format!("PDFium could not apply {}: {error}", path.display()))?;
    drop(bitmap);

    Ok(object)
}

/// The image laid on a turned A4 sheet, scaled to fill. An image has no page
/// size of its own, so it is always fitted, whatever the merge's A4 option says.
pub(super) fn image_page_document<'a>(
    pdfium: &'a Pdfium,
    image: &PreparedImage,
    path: &Path,
) -> Result<PdfDocument<'a>, String> {
    let (raw_width, raw_height) = image.dimensions();
    let pixel_width = raw_width as f32;
    let pixel_height = raw_height as f32;

    if pixel_width < 1.0 || pixel_height < 1.0 {
        return Err(format!("{} has no pixels", path.display()));
    }

    let (sheet_width, sheet_height) = if pixel_width > pixel_height {
        (A4_LONG_POINTS, A4_SHORT_POINTS)
    } else {
        (A4_SHORT_POINTS, A4_LONG_POINTS)
    };
    let scale = (sheet_width / pixel_width).min(sheet_height / pixel_height);
    let width = pixel_width * scale;
    let height = pixel_height * scale;
    let mut document = pdfium
        .create_new_pdf()
        .map_err(|error| format!("PDFium could not create a document: {error}"))?;
    let mut object = match image {
        PreparedImage::Jpeg { bytes, .. } => {
            let mut object = PdfPageImageObject::new_from_jpeg_reader(
                &document,
                std::io::Cursor::new(bytes.as_slice()),
            )
            .map_err(|error| format!("PDFium could not place {}: {error}", path.display()))?;
            object
                .scale(width, height)
                .map_err(|error| format!("PDFium could not size {}: {error}", path.display()))?;
            object
        }
        PreparedImage::Bitmap(bitmap) => {
            opaque_bitmap_image_object(&document, bitmap, width, height, path)?
        }
    };

    object
        .translate(
            PdfPoints::new((sheet_width - width) / 2.0),
            PdfPoints::new((sheet_height - height) / 2.0),
        )
        .map_err(|error| format!("PDFium could not centre {}: {error}", path.display()))?;

    let mut page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::Custom(
            PdfPoints::new(sheet_width),
            PdfPoints::new(sheet_height),
        ))
        .map_err(|error| format!("PDFium could not create the image's sheet: {error}"))?;

    page.objects_mut()
        .add_image_object(object)
        .map_err(|error| format!("PDFium rejected {}: {error}", path.display()))?;
    page.regenerate_content()
        .map_err(|error| format!("PDFium could not finish the image's sheet: {error}"))?;
    drop(page);

    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_jpeg(sof_marker: u8, precision: u8, components: u8, app14: Option<u8>) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        if let Some(transform) = app14 {
            // APP14 "Adobe" segment (length = 14: 2 len + 12 payload)
            bytes.extend_from_slice(&[0xFF, 0xEE, 0x00, 0x0E]);
            bytes.extend_from_slice(b"Adobe");
            bytes.extend_from_slice(&[0, 100, 0, 0, 0, 0, transform]);
        }
        // SOF segment: 2 len + 6 header bytes (precision, h, w, components)
        bytes.extend_from_slice(&[
            0xFF, sof_marker, 0x00, 0x08, precision, 0, 10, 0, 10, components,
        ]);
        // SOS marker
        bytes.extend_from_slice(&[0xFF, 0xDA]);
        bytes
    }

    #[test]
    fn passthrough_jpeg_accepts_baseline_gray_and_ycbcr_only() {
        assert!(is_safe_passthrough_jpeg(&synthetic_jpeg(0xC0, 8, 3, None)));
        assert!(is_safe_passthrough_jpeg(&synthetic_jpeg(0xC0, 8, 1, None)));
        assert!(is_safe_passthrough_jpeg(&synthetic_jpeg(
            0xC0,
            8,
            3,
            Some(1)
        )));

        // Progressive, CMYK (4 components), 12-bit, and Adobe raw-RGB decline.
        assert!(!is_safe_passthrough_jpeg(&synthetic_jpeg(0xC2, 8, 3, None)));
        assert!(!is_safe_passthrough_jpeg(&synthetic_jpeg(0xC0, 8, 4, None)));
        assert!(!is_safe_passthrough_jpeg(&synthetic_jpeg(
            0xC0, 12, 3, None
        )));
        assert!(!is_safe_passthrough_jpeg(&synthetic_jpeg(
            0xC0,
            8,
            3,
            Some(0)
        )));
        assert!(!is_safe_passthrough_jpeg(b"not a jpeg"));
    }

    #[test]
    fn composite_onto_white_blends_alpha_and_drops_channel() {
        let rgba = image::RgbaImage::from_fn(2, 1, |x, _| {
            if x == 0 {
                image::Rgba([0, 0, 0, 0])
            } else {
                image::Rgba([0, 100, 200, 128])
            }
        });
        let flat = composite_onto_white(DynamicImage::ImageRgba8(rgba));
        let rgb = flat.as_rgb8().expect("RGBA should flatten to RGB8");
        assert_eq!(rgb.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(rgb.get_pixel(1, 0).0, [127, 177, 227]);
    }
}
