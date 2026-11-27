use super::*;
use crate::pdfium::compress::{CompressionEstimate, CompressionOptions};

// Image quality percentage accepted from the WebView; 100 keeps original
// image bytes untouched and compresses PDF structure alone.
const MAX_IMAGE_QUALITY: u8 = 100;

// Resolution and JPEG quality endpoints mapped from `0..=99`.
const MIN_IMAGE_DPI: f32 = 72.0;
const MAX_IMAGE_DPI: f32 = 300.0;
const MIN_JPEG_QUALITY: u8 = 50;
const MAX_JPEG_QUALITY: u8 = 90;

// Small hysteresis so images already within 5% of the target resolution are
// re-encoded without an unnoticeable 1-pixel resize, while avoiding steep
// jumps along the continuous slider.
const RESAMPLE_MARGIN: f32 = 1.05;

// Images below this many pixels are logos and dividers: recompressing them
// buys bytes nobody misses while risking the details everyone sees.
const MIN_IMAGE_PIXELS: u64 = 16_384;

// The most raw samples one image may decode to, matching the `image` crate's
// default allocation limit that already bounds the JPEG path.
const MAX_DECODED_BYTES: usize = 512 << 20;

// Cap on decompressing an `/ICCBased` profile stream to inspect its 128-byte
// header. Real RGB/Gray profiles are a few kilobytes; bounding this prevents a
// flate bomb disguised as a colour profile.
const MAX_ICC_PROFILE_BYTES: usize = 4 << 20;

// Bound on indirect reference chains in image dictionaries so a cycle cannot
// spin forever.
const MAX_DEREF_DEPTH: usize = 8;

// A replacement must come in at or under this share of the stream it replaces.
const MAX_RECOMPRESSED_PERCENT: u64 = 90;

/// Colour channels the pass can decode, resize, and re-encode as JPEG while
/// preserving the image's PDF `/ColorSpace` entry intact.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ImageChannels {
    Gray,
    Rgb,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ImageFilter {
    Dct,
    Flate,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SoftMaskFilter {
    None,
    Flate,
}

#[derive(Clone, Copy)]
struct SoftMaskSpec {
    id: lopdf::ObjectId,
    width: u32,
    height: u32,
    filter: SoftMaskFilter,
}

#[derive(Clone, Copy)]
struct ImageSpec {
    width: u32,
    height: u32,
    channels: ImageChannels,
    filter: ImageFilter,
    smask: Option<SoftMaskSpec>,
}

/// The one choice's two levers: the resolution images are resampled down to,
/// and the JPEG quality they land on — matched, so a lower resolution is
/// smaller on both axes.
struct ImageLevels {
    target_dpi: f32,
    quality: u8,
}

fn image_levels(options: CompressionOptions) -> Result<Option<ImageLevels>, String> {
    if options.image_quality > MAX_IMAGE_QUALITY {
        return Err(format!(
            "image quality must sit between 0 and {MAX_IMAGE_QUALITY}, not {}",
            options.image_quality
        ));
    }

    // 100% is the structure-only choice: images keep their very bytes.
    if options.image_quality == MAX_IMAGE_QUALITY {
        return Ok(None);
    }

    let t = options.image_quality as f32 / (MAX_IMAGE_QUALITY - 1) as f32;
    let target_dpi = MIN_IMAGE_DPI + t * (MAX_IMAGE_DPI - MIN_IMAGE_DPI);
    let quality =
        (MIN_JPEG_QUALITY as f32 + t * (MAX_JPEG_QUALITY - MIN_JPEG_QUALITY) as f32).round() as u8;

    Ok(Some(ImageLevels {
        target_dpi,
        quality,
    }))
}

/// Follows indirect references with a depth bound so malformed cycles cannot loop.
fn resolve<'a>(
    loaded: &'a lopdf::Document,
    mut object: &'a lopdf::Object,
) -> Option<&'a lopdf::Object> {
    for _ in 0..MAX_DEREF_DEPTH {
        match object {
            lopdf::Object::Reference(id) => object = loaded.get_object(*id).ok()?,
            _ => return Some(object),
        }
    }

    None
}

/// Dictionary lookups that read absent or wrongly typed as `None`, the way an
/// ineligible image does rather than an ill-formed document.
fn named<'a>(
    loaded: &'a lopdf::Document,
    dict: &'a lopdf::Dictionary,
    key: &[u8],
) -> Option<&'a [u8]> {
    let object = resolve(loaded, dict.get(key).ok()?)?;
    object.as_name().ok()
}

fn integer(loaded: &lopdf::Document, dict: &lopdf::Dictionary, key: &[u8]) -> Option<i64> {
    let object = resolve(loaded, dict.get(key).ok()?)?;
    object.as_i64().ok()
}

fn flag(loaded: &lopdf::Document, dict: &lopdf::Dictionary, key: &[u8]) -> Option<bool> {
    let object = resolve(loaded, dict.get(key).ok()?)?;
    object.as_bool().ok()
}

/// True when `object` is an array of `pairs` default `[0, 1]` pairs, matching
/// the identity `/Decode` or `/Range` mapping.
fn is_unit_pairs(loaded: &lopdf::Document, object: &lopdf::Object, pairs: usize) -> bool {
    let Some(items) = resolve(loaded, object).and_then(|object| object.as_array().ok()) else {
        return false;
    };
    if items.len() != pairs * 2 {
        return false;
    }

    items.as_chunks::<2>().0.iter().all(|[low, high]| {
        let low = resolve(loaded, low).and_then(|o| o.as_float().ok());
        let high = resolve(loaded, high).and_then(|o| o.as_float().ok());
        low == Some(0.0) && high == Some(1.0)
    })
}

/// True when `/DecodeParms` carries actual filter parameters (such as a PNG
/// predictor or JPEG `/ColorTransform 0`) rather than being absent, null, or
/// an empty dictionary.
fn has_decode_parms(loaded: &lopdf::Document, dict: &lopdf::Dictionary) -> bool {
    let Ok(raw) = dict.get(b"DecodeParms") else {
        return false;
    };
    let Some(resolved) = resolve(loaded, raw) else {
        return true;
    };

    let is_empty = |object: &lopdf::Object| match resolve(loaded, object) {
        Some(lopdf::Object::Null) => true,
        Some(lopdf::Object::Dictionary(d)) => d.is_empty(),
        _ => false,
    };

    match resolved {
        lopdf::Object::Null => false,
        lopdf::Object::Dictionary(d) => !d.is_empty(),
        lopdf::Object::Array(items) if items.len() == 1 => !is_empty(&items[0]),
        _ => true,
    }
}

/// Confirms an `/ICCBased` profile stream is a grayscale or RGB profile by its
/// ICC header (signature `acsp` at offset 36 and colour space `GRAY` or `RGB `
/// at offset 16), declining CMYK, Lab, XYZ and malformed profiles.
fn icc_channels(loaded: &lopdf::Document, profile: &lopdf::Stream) -> Option<ImageChannels> {
    let n = integer(loaded, &profile.dict, b"N")?;
    if !matches!(n, 1 | 3) {
        return None;
    }

    if let Ok(range) = profile.dict.get(b"Range") {
        if !is_unit_pairs(loaded, range, n as usize) {
            return None;
        }
    }

    let bytes = profile
        .decompressed_content_with_limit(MAX_ICC_PROFILE_BYTES)
        .ok()?;
    if bytes.len() < 128 || &bytes[36..40] != b"acsp" {
        return None;
    }

    match (n, &bytes[16..20]) {
        (1, b"GRAY") => Some(ImageChannels::Gray),
        (3, b"RGB ") => Some(ImageChannels::Rgb),
        _ => None,
    }
}

/// Resolves the image's `/ColorSpace` to grayscale or RGB when its samples can
/// be re-encoded as JPEG while keeping the original `/ColorSpace` entry intact.
/// Indexed palettes, CMYK, Lab, Separation and DeviceN colour spaces decline.
fn image_channels(loaded: &lopdf::Document, dict: &lopdf::Dictionary) -> Option<ImageChannels> {
    let space = resolve(loaded, dict.get(b"ColorSpace").ok()?)?;

    match space {
        lopdf::Object::Name(name) => match name.as_slice() {
            b"DeviceGray" => Some(ImageChannels::Gray),
            b"DeviceRGB" => Some(ImageChannels::Rgb),
            _ => None,
        },
        lopdf::Object::Array(items) => {
            let name = resolve(loaded, items.first()?)?.as_name().ok()?;

            match (name, items.as_slice()) {
                (b"DeviceGray", [_]) => Some(ImageChannels::Gray),
                (b"DeviceRGB", [_]) => Some(ImageChannels::Rgb),
                (b"CalGray", [_, params]) => {
                    resolve(loaded, params)?.as_dict().ok()?;
                    Some(ImageChannels::Gray)
                }
                (b"CalRGB", [_, params]) => {
                    resolve(loaded, params)?.as_dict().ok()?;
                    Some(ImageChannels::Rgb)
                }
                (b"ICCBased", [_, target]) => {
                    let profile = resolve(loaded, target)?.as_stream().ok()?;
                    icc_channels(loaded, profile)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// A single supported filter, either by name or as a one-element array; multi-
/// filter chains decline.
fn image_filter(loaded: &lopdf::Document, dict: &lopdf::Dictionary) -> Option<ImageFilter> {
    let filter = resolve(loaded, dict.get(b"Filter").ok()?)?;
    let name = match filter {
        lopdf::Object::Name(name) => name.as_slice(),
        lopdf::Object::Array(items) if items.len() == 1 => {
            resolve(loaded, &items[0])?.as_name().ok()?
        }
        _ => return None,
    };

    match name {
        b"DCTDecode" => Some(ImageFilter::Dct),
        b"FlateDecode" => Some(ImageFilter::Flate),
        _ => None,
    }
}

/// Soft-mask filter: either uncompressed or `FlateDecode` (single filter, no
/// predictor chain).
fn smask_filter(loaded: &lopdf::Document, dict: &lopdf::Dictionary) -> Option<SoftMaskFilter> {
    let Ok(raw) = dict.get(b"Filter") else {
        return Some(SoftMaskFilter::None);
    };
    let filter = resolve(loaded, raw)?;
    let name = match filter {
        lopdf::Object::Name(name) => name.as_slice(),
        lopdf::Object::Array(items) if items.len() == 1 => {
            resolve(loaded, &items[0])?.as_name().ok()?
        }
        _ => return None,
    };

    match name {
        b"FlateDecode" => Some(SoftMaskFilter::Flate),
        _ => None,
    }
}

/// Validates a standard 8-bit grayscale `/SMask` stream. Masks carrying
/// `/Matte` decline: their parent's RGB samples are premultiplied against the
/// matte colour, so JPEG error divided by low alpha produces bright halos.
fn recompressible_smask(
    loaded: &lopdf::Document,
    id: lopdf::ObjectId,
    stream: &lopdf::Stream,
) -> Option<SoftMaskSpec> {
    let dict = &stream.dict;

    if !matches!(named(loaded, dict, b"Subtype"), Some(b"Image")) {
        return None;
    }

    if !matches!(named(loaded, dict, b"Type"), None | Some(b"XObject")) {
        return None;
    }

    if flag(loaded, dict, b"ImageMask") == Some(true)
        || dict.has(b"Matte")
        || dict.has(b"SMask")
        || dict.has(b"Mask")
        || has_decode_parms(loaded, dict)
    {
        return None;
    }

    // PDF requires `/SMask` to be `DeviceGray`.
    let color_space = resolve(loaded, dict.get(b"ColorSpace").ok()?)?;
    let is_device_gray = match color_space {
        lopdf::Object::Name(name) => name == b"DeviceGray",
        lopdf::Object::Array(items) if items.len() == 1 => {
            resolve(loaded, &items[0]).and_then(|o| o.as_name().ok()) == Some(b"DeviceGray")
        }
        _ => false,
    };
    if !is_device_gray {
        return None;
    }

    if let Ok(decode) = dict.get(b"Decode") {
        if !is_unit_pairs(loaded, decode, 1) {
            return None;
        }
    }

    if integer(loaded, dict, b"BitsPerComponent") != Some(8) {
        return None;
    }

    let filter = smask_filter(loaded, dict)?;
    let width = integer(loaded, dict, b"Width")?;
    let height = integer(loaded, dict, b"Height")?;
    if width <= 0 || height <= 0 {
        return None;
    }
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    let expected = (width as usize).checked_mul(height as usize)?;
    if expected > MAX_DECODED_BYTES {
        return None;
    }

    Some(SoftMaskSpec {
        id,
        width,
        height,
        filter,
    })
}

/// Whether this stream is an image the pass knows how to rebuild. Hard masks
/// (`/Mask`, including colour-key arrays that JPEG error would break), masks
/// with `/Matte` premultiplication, stencils, CMYK/Lab/indexed colour spaces,
/// non-identity decode tables and filter chains the pass does not model all
/// pass through untouched. Soft-masked images (`/SMask`) keep their alpha
/// channel lossless `FlateDecode` while the colour stream becomes JPEG; a mask
/// itself looks like any gray image from inside, so `mask_ids` excludes those.
fn recompressible_image(
    loaded: &lopdf::Document,
    id: lopdf::ObjectId,
    stream: &lopdf::Stream,
) -> Option<ImageSpec> {
    let dict = &stream.dict;

    if !matches!(named(loaded, dict, b"Subtype"), Some(b"Image")) {
        return None;
    }

    if !matches!(named(loaded, dict, b"Type"), None | Some(b"XObject")) {
        return None;
    }

    if flag(loaded, dict, b"ImageMask") == Some(true) {
        return None;
    }

    if dict.has(b"Mask") || has_decode_parms(loaded, dict) {
        return None;
    }

    let smask = if let Ok(raw) = dict.get(b"SMask") {
        match raw {
            lopdf::Object::Name(name) if name == b"None" => None,
            lopdf::Object::Reference(smask_id) if *smask_id != id => {
                let smask_stream = loaded.get_object(*smask_id).ok()?.as_stream().ok()?;
                Some(recompressible_smask(loaded, *smask_id, smask_stream)?)
            }
            _ => return None,
        }
    } else {
        None
    };

    let width = integer(loaded, dict, b"Width")?;
    let height = integer(loaded, dict, b"Height")?;

    if width <= 0 || height <= 0 || (width as u64) * (height as u64) < MIN_IMAGE_PIXELS {
        return None;
    }

    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    let channels = image_channels(loaded, dict)?;

    if let Ok(decode) = dict.get(b"Decode") {
        let pairs = match channels {
            ImageChannels::Gray => 1,
            ImageChannels::Rgb => 3,
        };
        if !is_unit_pairs(loaded, decode, pairs) {
            return None;
        }
    }

    let filter = image_filter(loaded, dict)?;
    if filter == ImageFilter::Flate && integer(loaded, dict, b"BitsPerComponent") != Some(8) {
        return None;
    }

    Some(ImageSpec {
        width,
        height,
        channels,
        filter,
        smask,
    })
}

/// The image a stream holds, decoded — `None` for every stream this pass
/// declines, which leaves it exactly as it was. The decoded channel layout must
/// match the PDF `/ColorSpace` so keeping that entry intact never mislabels the
/// replacement JPEG.
fn decoded_image(stream: &lopdf::Stream, spec: ImageSpec) -> Result<Option<DynamicImage>, String> {
    match spec.filter {
        ImageFilter::Dct => match (spec.channels, image::load_from_memory(&stream.content)) {
            (ImageChannels::Gray, Ok(image @ DynamicImage::ImageLuma8(_))) => Ok(Some(image)),
            (ImageChannels::Rgb, Ok(image @ DynamicImage::ImageRgb8(_))) => Ok(Some(image)),
            // A decode the `image` crate refuses — or whose channels disagree
            // with `/ColorSpace` — declines the image, not the document.
            _ => Ok(None),
        },
        ImageFilter::Flate => {
            let (grayscale, channels) = match spec.channels {
                ImageChannels::Gray => (true, 1usize),
                ImageChannels::Rgb => (false, 3usize),
            };
            // The declared size is the file's to claim, so it is bounded too:
            // a 60000-pixel square would otherwise license gigabytes.
            let Some(expected) = (spec.width as usize)
                .checked_mul(spec.height as usize)
                .and_then(|samples| samples.checked_mul(channels))
                .filter(|&expected| expected <= MAX_DECODED_BYTES)
            else {
                return Ok(None);
            };
            // Capped at the declared size: a few kilobytes of flate can
            // otherwise inflate into gigabytes.
            let Ok(samples) = stream.decompressed_content_with_limit(expected) else {
                return Ok(None);
            };

            if samples.len() != expected {
                return Ok(None);
            }

            let rebuilt = if grayscale {
                DynamicImage::ImageLuma8(
                    image::ImageBuffer::from_raw(spec.width, spec.height, samples)
                        .ok_or("a grayscale image's samples did not fill its declared size")?,
                )
            } else {
                DynamicImage::ImageRgb8(
                    image::ImageBuffer::from_raw(spec.width, spec.height, samples)
                        .ok_or("a colour image's samples did not fill its declared size")?,
                )
            };

            Ok(Some(rebuilt))
        }
    }
}

fn decoded_smask(stream: &lopdf::Stream, spec: SoftMaskSpec) -> Option<Vec<u8>> {
    let expected = (spec.width as usize).checked_mul(spec.height as usize)?;
    if expected > MAX_DECODED_BYTES {
        return None;
    }
    let samples = match spec.filter {
        SoftMaskFilter::None => stream.content.clone(),
        SoftMaskFilter::Flate => stream.decompressed_content_with_limit(expected).ok()?,
    };
    (samples.len() == expected).then_some(samples)
}

fn flate_compress(samples: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder
        .write_all(samples)
        .and_then(|()| encoder.finish())
        .map_err(|error| format!("an image mask could not be compressed: {error}"))
}

enum SoftMaskUpdate {
    Keep,
    Drop {
        id: lopdf::ObjectId,
        exclusive: bool,
    },
    ReplaceInPlace {
        id: lopdf::ObjectId,
        compressed: Vec<u8>,
        width: u32,
        height: u32,
    },
}

/// One image downscaled and re-encoded: its JPEG bytes, new pixel size, and
/// any lossless update to its `/SMask`.
struct RecompressedImage {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    smask: SoftMaskUpdate,
}

/// The image resampled toward the target resolution, given the lowest one it
/// is drawn at, and re-encoded. `None` when the replacement would not save
/// enough, which is the pass's promise to every image it declines.
fn recompressed_image(
    stream: &lopdf::Stream,
    smask_stream: Option<(&lopdf::Stream, bool)>,
    spec: ImageSpec,
    levels: &ImageLevels,
    drawn_dpi: f32,
) -> Result<Option<RecompressedImage>, String> {
    let Some(pixels) = decoded_image(stream, spec)? else {
        return Ok(None);
    };

    let resampled = drawn_dpi > levels.target_dpi * RESAMPLE_MARGIN;
    let pixels = if resampled {
        let scale = levels.target_dpi / drawn_dpi;
        let width = ((pixels.width() as f32 * scale).round() as u32).max(1);
        let height = ((pixels.height() as f32 * scale).round() as u32).max(1);

        pixels.resize_exact(width, height, imageops::FilterType::CatmullRom)
    } else {
        pixels
    };
    let (width, height) = (pixels.width(), pixels.height());

    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, levels.quality)
        .encode_image(&pixels)
        .map_err(|error| format!("an image could not be re-encoded: {error}"))?;

    let (smask_update, old_bytes, new_bytes) = match (spec.smask, smask_stream) {
        (Some(smask_spec), Some((mask, exclusive))) => {
            let Some(samples) = decoded_smask(mask, smask_spec) else {
                return Ok(None);
            };
            if samples.iter().all(|&alpha| alpha == 255) {
                let old = stream.content.len() + if exclusive { mask.content.len() } else { 0 };
                (
                    SoftMaskUpdate::Drop {
                        id: smask_spec.id,
                        exclusive,
                    },
                    old,
                    jpeg.len(),
                )
            } else if resampled && exclusive {
                // Triangle resampling is monotonic so hard alpha edges do not
                // ring, and the mask stays lossless FlateDecode.
                let Some(gray) =
                    image::GrayImage::from_raw(smask_spec.width, smask_spec.height, samples)
                else {
                    return Ok(None);
                };
                let resized =
                    imageops::resize(&gray, width, height, imageops::FilterType::Triangle);
                let compressed = flate_compress(resized.as_raw())?;
                if compressed.len() < mask.content.len() {
                    (
                        SoftMaskUpdate::ReplaceInPlace {
                            id: smask_spec.id,
                            compressed: compressed.clone(),
                            width,
                            height,
                        },
                        stream.content.len() + mask.content.len(),
                        jpeg.len() + compressed.len(),
                    )
                } else {
                    (SoftMaskUpdate::Keep, stream.content.len(), jpeg.len())
                }
            } else {
                // Non-resampled masks and shared masks stay untouched: PDF maps
                // `/SMask` onto the parent image's unit square independently of
                // pixel dimensions.
                (SoftMaskUpdate::Keep, stream.content.len(), jpeg.len())
            }
        }
        (None, None) => (SoftMaskUpdate::Keep, stream.content.len(), jpeg.len()),
        _ => return Ok(None),
    };

    // Every re-encode of a JPEG loses detail again, so a marginal saving on one
    // already lossy is a bad trade.
    if new_bytes as u64 * 100 > old_bytes as u64 * MAX_RECOMPRESSED_PERCENT {
        return Ok(None);
    }

    Ok(Some(RecompressedImage {
        jpeg,
        width,
        height,
        smask: smask_update,
    }))
}

/// Every stream some image names as its `/SMask` or `/Mask`: alpha and stencil
/// samples, which JPEG artifacts would tear.
fn mask_ids(loaded: &lopdf::Document) -> HashSet<lopdf::ObjectId> {
    loaded
        .objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .flat_map(|stream| {
            [b"SMask".as_slice(), b"Mask"]
                .into_iter()
                .filter_map(|key| stream.dict.get(key).ok()?.as_reference().ok())
        })
        .collect()
}

/// Counts every indirect reference across the document pointing at an id in
/// `watched`, so an `/SMask` is mutated or removed in-place only when its
/// parent image is its sole reference anywhere in the PDF.
fn reference_counts(
    loaded: &lopdf::Document,
    watched: &HashSet<lopdf::ObjectId>,
) -> HashMap<lopdf::ObjectId, usize> {
    let mut counts = HashMap::new();
    if watched.is_empty() {
        return counts;
    }

    let mut stack: Vec<&lopdf::Object> = loaded.objects.values().collect();
    for (_, value) in loaded.trailer.iter() {
        stack.push(value);
    }

    while let Some(object) = stack.pop() {
        match object {
            lopdf::Object::Reference(id) if watched.contains(id) => {
                *counts.entry(*id).or_insert(0) += 1;
            }
            lopdf::Object::Array(items) => stack.extend(items.iter()),
            lopdf::Object::Dictionary(dict) => {
                for (_, value) in dict.iter() {
                    stack.push(value);
                }
            }
            lopdf::Object::Stream(stream) => {
                for (_, value) in stream.dict.iter() {
                    stack.push(value);
                }
            }
            _ => {}
        }
    }

    counts
}

/// Rewrites every eligible image the pages draw, announcing one step per
/// image. `false` reports a stop read between images.
fn recompress_images(
    loaded: &mut lopdf::Document,
    drawn_dpis: &HashMap<lopdf::ObjectId, f32>,
    operation: &OperationGuard<'_>,
    levels: &ImageLevels,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<bool, String> {
    let masks = mask_ids(loaded);
    let mask_refs = reference_counts(loaded, &masks);
    let targets: Vec<(lopdf::ObjectId, f32, ImageSpec)> = loaded
        .objects
        .iter()
        .filter(|(id, _)| !masks.contains(id))
        .filter_map(|(id, object)| {
            let drawn_dpi = *drawn_dpis.get(id)?;
            let spec = recompressible_image(loaded, *id, object.as_stream().ok()?)?;

            Some((*id, drawn_dpi, spec))
        })
        .collect();
    let total = targets.len();

    on_progress(0, total);

    for (step, (id, drawn_dpi, spec)) in targets.into_iter().enumerate() {
        // Between images, as every long loop must.
        if operation.is_cancelled() {
            return Ok(false);
        }

        let outcome = {
            let Some(stream) = loaded
                .objects
                .get(&id)
                .and_then(|object| object.as_stream().ok())
            else {
                on_progress(step + 1, total);
                continue;
            };
            let smask_stream = spec.smask.and_then(|smask_spec| {
                let mask = loaded
                    .objects
                    .get(&smask_spec.id)
                    .and_then(|object| object.as_stream().ok())?;
                let exclusive = mask_refs.get(&smask_spec.id) == Some(&1);
                Some((mask, exclusive))
            });

            recompressed_image(stream, smask_stream, spec, levels, drawn_dpi)?
        };

        if let Some(image) = outcome {
            if let Some(object) = loaded.objects.get_mut(&id) {
                let stream = object
                    .as_stream_mut()
                    .map_err(|_| format!("object {id:?} stopped being an image mid-pass"))?;

                stream.set_content(image.jpeg);
                stream.dict.set("Width", image.width as i64);
                stream.dict.set("Height", image.height as i64);
                stream.dict.set("Filter", "DCTDecode");
                stream.dict.set("BitsPerComponent", 8);
                stream.dict.remove(b"DecodeParms");
                if matches!(image.smask, SoftMaskUpdate::Drop { .. }) {
                    stream.dict.remove(b"SMask");
                }
            }

            match image.smask {
                SoftMaskUpdate::Keep => {}
                SoftMaskUpdate::Drop {
                    id: smask_id,
                    exclusive: true,
                } => {
                    loaded.objects.remove(&smask_id);
                }
                SoftMaskUpdate::Drop {
                    exclusive: false, ..
                } => {}
                SoftMaskUpdate::ReplaceInPlace {
                    id: smask_id,
                    compressed,
                    width,
                    height,
                } => {
                    if let Some(mask_stream) = loaded
                        .objects
                        .get_mut(&smask_id)
                        .and_then(|object| object.as_stream_mut().ok())
                    {
                        mask_stream.set_content(compressed);
                        mask_stream.dict.set("Width", width as i64);
                        mask_stream.dict.set("Height", height as i64);
                        mask_stream.dict.set("Filter", "FlateDecode");
                        mask_stream.dict.set("BitsPerComponent", 8);
                        mask_stream.dict.remove(b"DecodeParms");
                    }
                }
            }
        }

        on_progress(step + 1, total);
    }

    Ok(true)
}

/// Every `/Subtype /Image` stream not measured by `image_dpi::image_dpis` —
/// images referenced only from annotation `/AP` streams, patterns, Type 3
/// glyphs, or uncalled XObjects — excluded from pass-1 dedup so they cannot
/// merge into a page-drawn image and get downsampled from the page's DPI.
fn unwalked_image_ids(
    loaded: &lopdf::Document,
    drawn_dpis: &HashMap<lopdf::ObjectId, f32>,
) -> HashSet<lopdf::ObjectId> {
    loaded
        .objects
        .iter()
        .filter(|(id, object)| {
            !drawn_dpis.contains_key(id)
                && object.as_stream().is_ok_and(|stream| {
                    stream
                        .dict
                        .get(b"Subtype")
                        .ok()
                        .and_then(|value| value.as_name().ok())
                        == Some(b"Image")
                })
        })
        .map(|(&id, _)| id)
        .collect()
}

/// Post-pass-1 deduplicated document paired with the drawn DPIs in its own
/// `ObjectId` space, so every quality slider estimate clones directly without
/// re-parsing or re-deduplicating.
struct PreparedDocument {
    document: lopdf::Document,
    drawn_dpis: HashMap<lopdf::ObjectId, f32>,
}

#[derive(Clone)]
enum CompressSnapshot {
    /// PDFium's raw rewrite, before lopdf parsing or pass-1 deduplication.
    Raw(Arc<Vec<u8>>),
    /// Deduplicated document and its aligned drawn DPIs.
    Prepared(Arc<PreparedDocument>),
}

/// The work a dialog's estimates share while the document stands still: every
/// resolution starts from the same rewrite and the same drawn resolutions, and
/// the export usually asks for the output the last estimate already made.
pub(super) struct CompressCache {
    version: u64,
    /// Whether the rewrite has the signatures drawn in: the reader's answer
    /// changes it without a content change, so it is part of the key.
    flattens: bool,
    rewritten_len: u64,
    snapshot: CompressSnapshot,
    latest: Option<(u8, Arc<Vec<u8>>)>,
}

/// What one run takes from the cache before letting go of the PDFium lock.
struct Basis {
    version: u64,
    flattens: bool,
    /// The size the dialog measures savings against.
    baseline: u64,
    rewritten_len: u64,
    snapshot: CompressSnapshot,
    latest: Option<(u8, Arc<Vec<u8>>)>,
}

impl Basis {
    fn latest_for(&self, options: CompressionOptions) -> Option<Arc<Vec<u8>>> {
        self.latest
            .as_ref()
            .filter(|(image_quality, _)| *image_quality == options.image_quality)
            .map(|(_, bytes)| Arc::clone(bytes))
    }
}

/// PDFium's rewrite — where unreferenced objects drop off — is the one step
/// that needs the PDFium lock, so it happens here, under the caller's guard,
/// once per content version.
/// A document other files were added to compresses what its Save As writes,
/// blank pages and file bookmarks with it.
fn basis(engine: &PdfiumEngine, entry: &mut OpenDocument) -> Result<Basis, String> {
    // An estimate made before the reader's answer measures the signatures as
    // they stand.
    let flattens = entry.output_flattens().unwrap_or(false);
    let cache = match entry.compress_cache.take() {
        Some(cache) if cache.version == entry.content_version && cache.flattens == flattens => {
            cache
        }
        _ => {
            let mut rewritten = match engine.combined_bytes(entry) {
                Some(combined) => combined?,
                None => {
                    let bytes = entry.document.save_to_bytes().map_err(|error| {
                        format!("PDFium could not rewrite the document: {error}")
                    })?;
                    match entry.outline_edits.as_deref() {
                        Some(edits) => outline::apply_outline_edits(bytes, edits)?,
                        None => bytes,
                    }
                }
            };

            if flattens {
                rewritten = signatures::flattened_bytes(rewritten)?;
            }

            let rewritten_len = rewritten.len() as u64;
            CompressCache {
                version: entry.content_version,
                flattens,
                rewritten_len,
                snapshot: CompressSnapshot::Raw(Arc::new(rewritten)),
                latest: None,
            }
        }
    };
    let basis = Basis {
        version: cache.version,
        flattens: cache.flattens,
        baseline: entry.loaded_len.unwrap_or(cache.rewritten_len),
        rewritten_len: cache.rewritten_len,
        snapshot: cache.snapshot.clone(),
        latest: cache.latest.clone(),
    };

    entry.compress_cache = Some(cache);
    Ok(basis)
}

/// The compressed output and the prepared snapshot built off the PDFium lock,
/// when this run was the first to prepare it. `None` reports a stop read
/// between the stages.
type CompressedRun = Option<(Vec<u8>, Option<Arc<PreparedDocument>>)>;

/// Prepares a raw rewrite once for image recompression: measures drawn DPIs
/// first, then runs pass-1 deduplication while keeping `/SMask`/`/Mask` streams
/// and unwalked images distinct so mask exclusivity and unwalked image
/// resolution stay intact, and folds `drawn_dpis` onto canonical IDs.
fn prepare_document(
    rewritten: &[u8],
    operation: &OperationGuard<'_>,
) -> Result<Option<PreparedDocument>, String> {
    let mut loaded = lopdf::Document::load_mem(rewritten)
        .map_err(|error| format!("the rewritten document could not be reread: {error}"))?;
    let Some(raw_dpis) = image_dpi::image_dpis(&loaded, &|| operation.is_cancelled()) else {
        return Ok(None);
    };

    let mut excluded = mask_ids(&loaded);
    excluded.extend(unwalked_image_ids(&loaded, &raw_dpis));

    let Some(remap) =
        dedup::deduplicate_objects(&mut loaded, &|| operation.is_cancelled(), &excluded)
    else {
        return Ok(None);
    };

    let mut drawn_dpis = HashMap::with_capacity(raw_dpis.len());
    for (id, dpi) in raw_dpis {
        let canonical = remap.get(&id).copied().unwrap_or(id);
        drawn_dpis
            .entry(canonical)
            .and_modify(|existing: &mut f32| *existing = existing.min(dpi))
            .or_insert(dpi);
    }

    Ok(Some(PreparedDocument {
        document: loaded,
        drawn_dpis,
    }))
}

/// Every eligible image resampled toward the reader's resolution, then
/// lopdf's object and cross-reference streams at flate's deepest level. lopdf
/// reads only bytes PDFium itself just wrote, the same arrangement as the
/// outline writer. Runs outside the PDFium lock: a large document's images are
/// seconds of work every render would otherwise queue behind.
fn compressed_output(
    basis: &Basis,
    operation: &OperationGuard<'_>,
    levels: Option<&ImageLevels>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> Result<CompressedRun, String> {
    let mut prepared_now = None;
    let mut loaded = match (levels, &basis.snapshot) {
        (Some(levels), CompressSnapshot::Prepared(prepared)) => {
            let mut doc = prepared.document.clone();
            if !recompress_images(
                &mut doc,
                &prepared.drawn_dpis,
                operation,
                levels,
                on_progress,
            )? {
                return Ok(None);
            }
            doc
        }
        (Some(levels), CompressSnapshot::Raw(rewritten)) => {
            let Some(prepared) = prepare_document(rewritten, operation)? else {
                return Ok(None);
            };
            let prepared = Arc::new(prepared);
            let mut doc = prepared.document.clone();
            if !recompress_images(
                &mut doc,
                &prepared.drawn_dpis,
                operation,
                levels,
                on_progress,
            )? {
                return Ok(None);
            }
            prepared_now = Some(prepared);
            doc
        }
        // Structure-only mode (`image_quality == 100`) skips pass-1 dedup and
        // DPI walking, running one global dedup pass after `loaded.compress()`.
        (None, CompressSnapshot::Prepared(prepared)) => prepared.document.clone(),
        (None, CompressSnapshot::Raw(rewritten)) => lopdf::Document::load_mem(rewritten)
            .map_err(|error| format!("the rewritten document could not be reread: {error}"))?,
    };

    // Streams no filter ever covers are the ones flate can still take;
    // already-filtered ones (page content, the images above) pass through
    // untouched.
    loaded.compress();

    // Deduplicate all identical streams and resource objects (including masks
    // and unwalked images) after compression, and prune orphaned objects.
    if dedup::deduplicate_objects(&mut loaded, &|| operation.is_cancelled(), &HashSet::new())
        .is_none()
    {
        return Ok(None);
    }

    // Object streams are a 1.5 feature, so a header older than that would
    // misdescribe the file about to be written. Real version strings run
    // 1.0–1.7 then 2.0, where lexicographic order is numeric order.
    if loaded.version.as_str() < "1.5" {
        loaded.version = "1.5".to_string();
    }

    if operation.is_cancelled() {
        return Ok(None);
    }

    let options = lopdf::SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(9)
        .build();
    let mut compressed = Vec::with_capacity(basis.rewritten_len as usize);
    loaded
        .save_with_options(&mut compressed, options)
        .map_err(|error| format!("the compressed document could not be written: {error}"))?;

    Ok((!operation.is_cancelled()).then_some((compressed, prepared_now)))
}

impl PdfiumEngine {
    /// Like an archive, a compressed copy is a different file by construction:
    /// it cannot replace any open PDF, its own source included, whose edit
    /// history it would silently stop describing, nor any signed file.
    fn refuse_open_destination(
        &self,
        documents: &HashMap<u64, OpenDocument>,
        path: &Path,
    ) -> Result<(), String> {
        if io::is_open_document_file(documents, path, None) {
            return Err("a compressed copy cannot replace an open PDF".into());
        }

        if self.is_signed_file(documents, path) {
            return Err(signatures::EXPORT_SIGNED_ERROR.into());
        }

        Ok(())
    }

    fn compress_basis(&self, document_id: u64) -> Result<Basis, String> {
        let mut documents = self.lock_documents()?;

        basis(self, open_entry_mut(&mut documents, document_id)?)
    }

    /// Files a finished run's work for the next one — unless the document
    /// changed meanwhile, the reader's signature answer changed what it
    /// measures, or the dialog released the cache.
    fn remember_compression(
        &self,
        document_id: u64,
        basis: &Basis,
        prepared: Option<Arc<PreparedDocument>>,
        latest: (u8, Arc<Vec<u8>>),
    ) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let Some(cache) = documents
            .get_mut(&document_id)
            .and_then(|entry| entry.compress_cache.as_mut())
            .filter(|cache| cache.version == basis.version && cache.flattens == basis.flattens)
        else {
            return Ok(());
        };

        if let Some(prepared) = prepared {
            cache.snapshot = CompressSnapshot::Prepared(prepared);
        }
        cache.latest = Some(latest);

        Ok(())
    }

    /// The dialog's bottom line: the estimate is the pipeline's own output, so
    /// exactly what the export writes, measured against the opened file while
    /// the document still matches it. `None` reports the run was stopped,
    /// which a superseding estimate or a closing dialog asks for; the answer
    /// it abandons was already unwanted.
    pub fn estimate_compression(
        &self,
        document_id: u64,
        options: CompressionOptions,
    ) -> Result<Option<CompressionEstimate>, String> {
        let levels = image_levels(options)?;
        let operation = self.begin_operation(OperationTarget::CompressEstimate(document_id));
        let basis = self.compress_basis(document_id)?;

        if let Some(latest) = basis.latest_for(options) {
            return Ok(Some(CompressionEstimate::new(
                basis.baseline,
                latest.len() as u64,
            )));
        }

        if operation.is_cancelled() {
            return Ok(None);
        }

        let Some((compressed, measured)) =
            compressed_output(&basis, &operation, levels.as_ref(), &mut |_, _| {})?
        else {
            return Ok(None);
        };
        let estimated = compressed.len() as u64;

        self.remember_compression(
            document_id,
            &basis,
            measured,
            (options.image_quality, Arc::new(compressed)),
        )?;

        Ok(Some(CompressionEstimate::new(basis.baseline, estimated)))
    }

    /// A compressed copy for a reader-chosen destination, announced per image
    /// where images are what the work is. `false` abandons, leaving no file.
    pub fn export_compressed(
        &self,
        document_id: u64,
        path: &Path,
        options: CompressionOptions,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let levels = image_levels(options)?;
        let operation = self.begin_operation(OperationTarget::Compress(document_id));
        let basis = {
            let mut documents = self.lock_documents()?;

            self.refuse_open_destination(&documents, path)?;
            let entry = open_entry_mut(&mut documents, document_id)?;
            entry.output_flattens()?;
            basis(self, entry)?
        };

        // The estimate for these levels usually already made these very bytes.
        let compressed = match basis.latest_for(options) {
            Some(latest) => latest,
            None => {
                let Some((compressed, _)) =
                    compressed_output(&basis, &operation, levels.as_ref(), &mut on_progress)?
                else {
                    return Ok(false);
                };

                Arc::new(compressed)
            }
        };

        // Checked again under the lock the write happens under: another
        // window may have opened this very path while the images were done.
        let documents = self.lock_documents()?;
        self.refuse_open_destination(&documents, path)?;

        io::write_file_atomically(path, |file| {
            file.write_all(&compressed)
                .map_err(|error| format!("could not write the compressed document: {error}"))
                .map(|()| true)
        })
    }

    /// The dialog is gone, and with it every reason to hold a copy or two of
    /// the document.
    pub fn release_compression(&self, document_id: u64) -> Result<(), String> {
        if let Some(entry) = self.lock_documents()?.get_mut(&document_id) {
            entry.compress_cache = None;
        }

        Ok(())
    }
}
