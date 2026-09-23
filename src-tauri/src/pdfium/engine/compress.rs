use super::*;
use crate::pdfium::compress::{CompressionEstimate, CompressionOptions};

// The resolutions the WebView offers, bounded here because a command's
// arguments are anyone's to send.
const MIN_IMAGE_DPI: u32 = 72;
const MAX_IMAGE_DPI: u32 = 300;

// Only images this far past the target are resampled: one just above it would
// trade visible softening for few bytes. Re-encoding alone still applies.
const RESAMPLE_MARGIN: f32 = 1.5;

// Images below this many pixels are logos and dividers: recompressing them
// buys bytes nobody misses while risking the details everyone sees.
const MIN_IMAGE_PIXELS: u64 = 16_384;

// The most raw samples one image may decode to, matching the `image` crate's
// default allocation limit that already bounds the JPEG path.
const MAX_DECODED_BYTES: usize = 512 << 20;

// A replacement must come in at or under this share of the stream it replaces.
const MAX_RECOMPRESSED_PERCENT: u64 = 90;

/// The one choice's two levers: the resolution images are resampled down to,
/// and the JPEG quality they land on — matched, so a lower resolution is
/// smaller on both axes.
struct ImageLevels {
    target_dpi: f32,
    quality: u8,
}

fn image_levels(options: CompressionOptions) -> Result<Option<ImageLevels>, String> {
    // No target is the structure-only choice: images keep their very bytes.
    let Some(dpi) = options.image_dpi else {
        return Ok(None);
    };

    if !(MIN_IMAGE_DPI..=MAX_IMAGE_DPI).contains(&dpi) {
        return Err(format!(
            "the image resolution must sit between {MIN_IMAGE_DPI} and {MAX_IMAGE_DPI} dpi, \
             not {dpi}"
        ));
    }

    Ok(Some(ImageLevels {
        target_dpi: dpi as f32,
        // 72 dpi keeps quality 60, 300 keeps 85.
        quality: (60 + (dpi - MIN_IMAGE_DPI) * 25 / (MAX_IMAGE_DPI - MIN_IMAGE_DPI)) as u8,
    }))
}

/// Dictionary lookups that read absent or wrongly typed as `None`, the way an
/// ineligible image does rather than an ill-formed document.
fn named<'a>(dict: &'a lopdf::Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).ok().and_then(|object| object.as_name().ok())
}

fn integer(dict: &lopdf::Dictionary, key: &[u8]) -> Option<i64> {
    dict.get(key).ok().and_then(|object| object.as_i64().ok())
}

fn flag(dict: &lopdf::Dictionary, key: &[u8]) -> Option<bool> {
    dict.get(key).ok().and_then(|object| object.as_bool().ok())
}

/// Whether this stream is an image the pass knows how to rebuild. Transparency
/// (`/SMask`, `/Mask`) is the line: a mask's samples must stay dimension-locked
/// to this image's, and downscaled JPEG artifacts in an alpha channel would
/// tear at every edge. A mask itself looks like any gray image from inside, so
/// `mask_ids` excludes those. Stencils, indexed and ICC colour spaces, decode
/// tables and filter chains the pass does not model all pass through untouched.
fn recompressible_image(stream: &lopdf::Stream) -> Option<(i64, i64)> {
    let dict = &stream.dict;

    if !matches!(named(dict, b"Subtype"), Some(b"Image")) {
        return None;
    }

    if !matches!(named(dict, b"Type"), None | Some(b"XObject")) {
        return None;
    }

    if flag(dict, b"ImageMask") == Some(true) {
        return None;
    }

    if dict.has(b"SMask") || dict.has(b"Mask") || dict.has(b"DecodeParms") || dict.has(b"Decode") {
        return None;
    }

    let width = integer(dict, b"Width")?;
    let height = integer(dict, b"Height")?;

    if width <= 0 || height <= 0 || (width as u64) * (height as u64) < MIN_IMAGE_PIXELS {
        return None;
    }

    // The replacement dict names a device colour space, so anything fancier
    // keeps its pixels. An ICC profile, an indexed palette or a reference is
    // an array or an indirect object, not a name, and must decline rather than
    // skip this check: re-labelling an ICC CMYK JPEG DeviceRGB shifts or even
    // inverts its colours.
    if !matches!(
        named(dict, b"ColorSpace"),
        Some(b"DeviceRGB" | b"DeviceGray")
    ) {
        return None;
    }

    // A lone filter by name; an array is a chain this pass does not rebuild.
    let filter = named(dict, b"Filter")?;
    (matches!(filter, b"DCTDecode" | b"FlateDecode")).then_some((width, height))
}

/// The image a stream holds, decoded — `None` for every stream this pass
/// declines, which leaves it exactly as it was. A decode the `image` crate
/// refuses (a CMYK JPEG, say) declines the same silent way: the reader's file
/// keeps working, just less compressed.
fn decoded_image(
    stream: &lopdf::Stream,
    width: i64,
    height: i64,
) -> Result<Option<(DynamicImage, bool)>, String> {
    match named(&stream.dict, b"Filter") {
        Some(b"DCTDecode") => {
            // Only the plain layouts re-encode cleanly; the dict's colour space
            // is rewritten below to whatever the pixels really are.
            match image::load_from_memory(&stream.content) {
                Ok(image @ DynamicImage::ImageLuma8(_)) => Ok(Some((image, true))),
                Ok(image @ DynamicImage::ImageRgb8(_)) => Ok(Some((image, false))),
                // A decode the `image` crate refuses — a CMYK JPEG, say —
                // declines the image, not the document.
                _ => Ok(None),
            }
        }
        Some(b"FlateDecode") => {
            // Raw 8-bit samples of a device colour space, nothing between them
            // and the pixels. Anything else — predictors, indexed palettes,
            // 16-bit depths — has a layout this pass would misread.
            let grayscale = match named(&stream.dict, b"ColorSpace") {
                Some(b"DeviceGray") => true,
                Some(b"DeviceRGB") => false,
                _ => return Ok(None),
            };

            if integer(&stream.dict, b"BitsPerComponent") != Some(8) {
                return Ok(None);
            }

            let channels = if grayscale { 1 } else { 3 };
            // The declared size is the file's to claim, so it is bounded too:
            // a 60000-pixel square would otherwise license gigabytes.
            let Some(expected) = (width as usize)
                .checked_mul(height as usize)
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
                    image::ImageBuffer::from_raw(width as u32, height as u32, samples)
                        .ok_or("a grayscale image's samples did not fill its declared size")?,
                )
            } else {
                DynamicImage::ImageRgb8(
                    image::ImageBuffer::from_raw(width as u32, height as u32, samples)
                        .ok_or("a colour image's samples did not fill its declared size")?,
                )
            };

            Ok(Some((rebuilt, grayscale)))
        }
        _ => Ok(None),
    }
}

/// One image downscaled and re-encoded: its JPEG bytes, new pixel size, and
/// whether it is grayscale — the colour space the replacement dict names.
struct RecompressedImage {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    grayscale: bool,
}

/// The image resampled toward the target resolution, given the lowest one it
/// is drawn at, and re-encoded. `None` when the JPEG would not save enough,
/// which is the pass's promise to every image it declines.
fn recompressed_image(
    stream: &lopdf::Stream,
    levels: &ImageLevels,
    drawn_dpi: f32,
) -> Result<Option<RecompressedImage>, String> {
    let Some((width, height)) = recompressible_image(stream) else {
        return Ok(None);
    };

    let Some((pixels, grayscale)) = decoded_image(stream, width, height)? else {
        return Ok(None);
    };

    let (width, height) = (width as u32, height as u32);
    let pixels = if drawn_dpi > levels.target_dpi * RESAMPLE_MARGIN {
        let scale = levels.target_dpi / drawn_dpi;
        let width = ((width as f32 * scale).round() as u32).max(1);
        let height = ((height as f32 * scale).round() as u32).max(1);

        pixels.resize_exact(width, height, imageops::FilterType::CatmullRom)
    } else {
        pixels
    };
    let (width, height) = (pixels.width(), pixels.height());

    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, levels.quality)
        .encode_image(&pixels)
        .map_err(|error| format!("an image could not be re-encoded: {error}"))?;

    // Every re-encode of a JPEG loses detail again, so a marginal saving on one
    // already lossy is a bad trade.
    if jpeg.len() as u64 * 100 > stream.content.len() as u64 * MAX_RECOMPRESSED_PERCENT {
        return Ok(None);
    }

    Ok(Some(RecompressedImage {
        jpeg,
        width,
        height,
        grayscale,
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
    let targets: Vec<(lopdf::ObjectId, f32)> = loaded
        .objects
        .iter()
        .filter(|(id, _)| !masks.contains(id))
        .filter_map(|(id, object)| {
            let drawn_dpi = *drawn_dpis.get(id)?;
            recompressible_image(object.as_stream().ok()?)?;

            Some((*id, drawn_dpi))
        })
        .collect();
    let total = targets.len();

    on_progress(0, total);

    for (step, (id, drawn_dpi)) in targets.into_iter().enumerate() {
        // Between images, as every long loop must.
        if operation.is_cancelled() {
            return Ok(false);
        }

        if let Some(object) = loaded.objects.get_mut(&id) {
            let stream = object
                .as_stream_mut()
                .map_err(|_| format!("object {id:?} stopped being an image mid-pass"))?;

            if let Some(image) = recompressed_image(stream, levels, drawn_dpi)? {
                stream.set_content(image.jpeg);
                stream.dict.set("Width", image.width as i64);
                stream.dict.set("Height", image.height as i64);
                stream.dict.set("Filter", "DCTDecode");
                stream.dict.set("BitsPerComponent", 8);
                stream.dict.set(
                    "ColorSpace",
                    if image.grayscale {
                        "DeviceGray"
                    } else {
                        "DeviceRGB"
                    },
                );
            }
        }

        on_progress(step + 1, total);
    }

    Ok(true)
}

type DrawnDpis = Arc<HashMap<lopdf::ObjectId, f32>>;

/// The work a dialog's estimates share while the document stands still: every
/// resolution starts from the same rewrite and the same drawn resolutions, and
/// the export usually asks for the output the last estimate already made.
pub(super) struct CompressCache {
    version: u64,
    rewritten: Arc<Vec<u8>>,
    drawn_dpis: Option<DrawnDpis>,
    latest: Option<(Option<u32>, Arc<Vec<u8>>)>,
}

/// What one run takes from the cache before letting go of the PDFium lock.
struct Basis {
    version: u64,
    /// The size the dialog measures savings against.
    baseline: u64,
    rewritten: Arc<Vec<u8>>,
    drawn_dpis: Option<DrawnDpis>,
    latest: Option<(Option<u32>, Arc<Vec<u8>>)>,
}

impl Basis {
    fn latest_for(&self, options: CompressionOptions) -> Option<Arc<Vec<u8>>> {
        self.latest
            .as_ref()
            .filter(|(image_dpi, _)| *image_dpi == options.image_dpi)
            .map(|(_, bytes)| Arc::clone(bytes))
    }
}

/// PDFium's rewrite — where unreferenced objects drop off — is the one step
/// that needs the PDFium lock, so it happens here, under the caller's guard,
/// once per content version.
fn basis(entry: &mut OpenDocument) -> Result<Basis, String> {
    let cache = match entry.compress_cache.take() {
        Some(cache) if cache.version == entry.content_version => cache,
        _ => CompressCache {
            version: entry.content_version,
            rewritten: Arc::new(
                entry
                    .document
                    .save_to_bytes()
                    .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?,
            ),
            drawn_dpis: None,
            latest: None,
        },
    };
    let basis = Basis {
        version: cache.version,
        baseline: entry.loaded_len.unwrap_or(cache.rewritten.len() as u64),
        rewritten: Arc::clone(&cache.rewritten),
        drawn_dpis: cache.drawn_dpis.clone(),
        latest: cache.latest.clone(),
    };

    entry.compress_cache = Some(cache);
    Ok(basis)
}

/// The compressed output and the drawn resolutions it measured, if it had to.
/// `None` reports a stop read between the stages.
type CompressedRun = Option<(Vec<u8>, Option<DrawnDpis>)>;

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
    let mut loaded = lopdf::Document::load_mem(&basis.rewritten)
        .map_err(|error| format!("the rewritten document could not be reread: {error}"))?;
    let mut measured = None;

    if let Some(levels) = levels {
        let drawn_dpis = match &basis.drawn_dpis {
            Some(drawn_dpis) => Arc::clone(drawn_dpis),
            None => {
                let Some(drawn_dpis) = image_dpi::image_dpis(&loaded, &|| operation.is_cancelled())
                else {
                    return Ok(None);
                };
                let drawn_dpis = Arc::new(drawn_dpis);

                measured = Some(Arc::clone(&drawn_dpis));
                drawn_dpis
            }
        };

        if !recompress_images(&mut loaded, &drawn_dpis, operation, levels, on_progress)? {
            return Ok(None);
        }
    }

    // Streams no filter ever covers are the ones flate can still take;
    // already-filtered ones (page content, the images above) pass through
    // untouched.
    loaded.compress();

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
    let mut compressed = Vec::with_capacity(basis.rewritten.len());
    loaded
        .save_with_options(&mut compressed, options)
        .map_err(|error| format!("the compressed document could not be written: {error}"))?;

    Ok((!operation.is_cancelled()).then_some((compressed, measured)))
}

/// Like an archive, a compressed copy is a different file by construction: it
/// cannot replace any open PDF, its own source included, whose edit history
/// it would silently stop describing.
fn refuse_open_destination(
    documents: &HashMap<u64, OpenDocument>,
    path: &Path,
) -> Result<(), String> {
    if documents.values().any(|document| {
        document
            .source_path
            .as_deref()
            .is_some_and(|source| io::same_file(source, path))
    }) {
        return Err("a compressed copy cannot replace an open PDF".into());
    }

    Ok(())
}

impl PdfiumEngine {
    fn compress_basis(&self, document_id: u64) -> Result<Basis, String> {
        let mut documents = self.lock_documents()?;

        basis(open_entry_mut(&mut documents, document_id)?)
    }

    /// Files a finished run's work for the next one — unless the document
    /// changed meanwhile, or the dialog released the cache.
    fn remember_compression(
        &self,
        document_id: u64,
        version: u64,
        measured: Option<DrawnDpis>,
        latest: (Option<u32>, Arc<Vec<u8>>),
    ) -> Result<(), String> {
        let mut documents = self.lock_documents()?;
        let Some(cache) = documents
            .get_mut(&document_id)
            .and_then(|entry| entry.compress_cache.as_mut())
            .filter(|cache| cache.version == version)
        else {
            return Ok(());
        };

        if cache.drawn_dpis.is_none() {
            cache.drawn_dpis = measured;
        }
        cache.latest = Some(latest);

        Ok(())
    }

    /// The dialog's bottom line: the estimate is the pipeline's own output, so
    /// exactly what the export writes, measured against the opened file while
    /// the document still matches it. `None` reports the run was stopped,
    /// which a superseding estimate or a closing dialog asks for; the answer
    /// it abandons was already unwanted.
    pub(in crate::pdfium) fn estimate_compression(
        &self,
        document_id: u64,
        options: CompressionOptions,
    ) -> Result<Option<CompressionEstimate>, String> {
        let levels = image_levels(options)?;
        let operation = self.begin_operation(OperationTarget::Compress(document_id));
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
            basis.version,
            measured,
            (options.image_dpi, Arc::new(compressed)),
        )?;

        Ok(Some(CompressionEstimate::new(basis.baseline, estimated)))
    }

    /// A compressed copy for a reader-chosen destination, announced per image
    /// where images are what the work is. `false` abandons, leaving no file.
    pub(in crate::pdfium) fn export_compressed(
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

            refuse_open_destination(&documents, path)?;
            basis(open_entry_mut(&mut documents, document_id)?)?
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
        refuse_open_destination(&documents, path)?;

        io::write_file_atomically(path, |file| {
            file.write_all(&compressed)
                .map_err(|error| format!("could not write the compressed document: {error}"))
                .map(|()| true)
        })
    }

    /// The dialog is gone, and with it every reason to hold a copy or two of
    /// the document.
    pub(in crate::pdfium) fn release_compression(&self, document_id: u64) -> Result<(), String> {
        if let Some(entry) = self.lock_documents()?.get_mut(&document_id) {
            entry.compress_cache = None;
        }

        Ok(())
    }
}
