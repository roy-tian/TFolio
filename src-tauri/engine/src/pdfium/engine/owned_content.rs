use serde::Serialize;

use super::*;

/// Result of a page-number rebuild: `applied` is `false` when stopped partway,
/// and `padding` carries the virtual padding blanks with any updated labels.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageNumbersOutcome {
    pub applied: bool,
    pub padding: Vec<PdfPaddingSheet>,
}

// Smart colour needs only an average luminance under one small label; a few
// pixels across it are enough to pick black or white.
pub(super) const PAGE_NUMBER_SAMPLE_DPI: f32 = 24.0;

// A little slack around the label's box, in display points, so the sample reads
// the drop the number sits on rather than a hairline of it.
pub(super) const PAGE_NUMBER_SAMPLE_PADDING: f32 = 4.0;

// Runs on every page of a document when blank detection is needed; 36 dpi gives
// ~298x421 pixels on A4, fine enough that short 12 pt text is never missed.
pub(super) const PAGE_BLANK_SCAN_DPI: f32 = 36.0;

/// One page-content layer's run of objects at a page's tail; identities are
/// read back from PDFium, not the source text, which an embedded font remaps.
#[derive(Clone, Debug)]
pub(super) struct OwnedSegment {
    pub(super) object_count: usize,
    pub(super) identities: Vec<String>,
}

/// Everything this session appended to one page, past the content found there.
/// The fixed layer order is what lets a change to one leave the others alone.
#[derive(Clone, Debug)]
pub(super) struct OwnedTailState {
    pub(super) base_objects: usize,
    pub(super) segments: Vec<OwnedSegment>,
}

impl OwnedTailState {
    pub(super) fn owned_objects(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| segment.object_count)
            .sum()
    }
}

/// The page number stamped on one page, kept by stable page id so watermark
/// changes, A4 copies, and undo restore the exact label rather than recomputing
/// numbers against a page list that may have changed since.
#[derive(Clone, Debug)]
pub(super) struct PageNumberStamp {
    pub(super) text: String,
    pub(super) anchor: PageNumberAnchor,
    pub(super) color: PdfColor,
    /// `/Rotate` of the page when the stamp was placed, so an undo puts back
    /// the orientation the page carried before a later replacement.
    pub(super) page_rotation: f32,
}

/// Everything the page-number layer held before a page-numbers command, stashed
/// by history entry id so an undo restores exact stamps even after edits that
/// shrank the document past the previous range.
#[derive(Clone, Debug)]
pub(super) struct PageNumbersSnapshot {
    pub(super) config: Option<PageNumbersConfig>,
    pub(super) stamps: HashMap<u64, PageNumberStamp>,
    pub(super) padding_numbers: HashMap<u64, PaddingPageNumber>,
}

/// The page-content layers this session owns, keyed by stable page id so the
/// record survives structure operations; empty `segments` is owned-but-bare.
#[derive(Clone, Debug)]
pub(super) struct OwnedContentState {
    pub(super) watermark: Option<WatermarkConfig>,
    pub(super) page_numbers: Option<PageNumbersConfig>,
    pub(super) per_page: HashMap<u64, OwnedTailState>,
    pub(super) page_number_stamps: HashMap<u64, PageNumberStamp>,
    /// Planned labels for virtual padding blanks between files, keyed by the
    /// stable page id of the page each blank immediately follows.
    pub(super) padding_numbers: HashMap<u64, PaddingPageNumber>,
    /// `content_version` at which page numbers were freshly computed for every
    /// page; a change since makes re-applying the same config rebuild rather
    /// than no-op.
    pub(super) page_numbers_version: Option<u64>,
}

impl OwnedContentState {
    /// When false the state is dropped and a save is no longer refused.
    pub(super) fn has_active_layer(&self) -> bool {
        self.watermark.is_some() || self.page_numbers.is_some()
    }
}

/// One layer's planned objects for one page, computed for every page before
/// any is touched, so a planning failure leaves the document untouched.
pub(super) struct WatermarkLayerPlan {
    pub(super) object_rotation: f32,
    pub(super) font_size: f32,
    pub(super) placements: Vec<WatermarkPlacement>,
}

#[derive(Clone, Copy)]
pub(super) struct WatermarkMetrics {
    pub(super) object_rotation: f32,
    pub(super) font_size: f32,
    pub(super) text_width: f32,
    pub(super) text_height: f32,
}

pub(super) struct PageOwnedPlan {
    pub(super) base_objects: usize,
    pub(super) page_number: i32,
    pub(super) watermark: Option<WatermarkLayerPlan>,
}

/// The watermark layer's rebuild inputs: config, resolved colour and, past
/// Latin-1, the face subset — cut before the lock; the font token loads inside.
pub(super) struct WatermarkResources {
    pub(super) config: WatermarkConfig,
    pub(super) color: PdfColor,
    pub(super) embedded: Option<Vec<u8>>,
}

/// The page-number layer's rebuild inputs: the config and a face already cut
/// to the label's glyphs, embedded as it stands.
pub(super) struct PageNumbersResources {
    pub(super) config: PageNumbersConfig,
    pub(super) face: Vec<u8>,
}

/// How the page-number layer behaves during a rebuild of owned tails.
pub(super) enum PageNumbersPlan {
    None,
    /// Fresh numbering walked across all pages and smart-padding blanks.
    Compute {
        resources: PageNumbersResources,
        /// 0-based page indices a Save As inserts a padding blank after.
        padding: Vec<usize>,
    },
    /// Keep existing per-page stamps (used when another layer changes, or when
    /// re-stamping lifted numbers onto an A4 copy), optionally resampling smart
    /// colour on the new backdrop.
    Preserve {
        resources: PageNumbersResources,
        stamps: HashMap<u64, PageNumberStamp>,
        padding_numbers: HashMap<u64, PaddingPageNumber>,
        resample_color: bool,
    },
    /// Undo of a page-numbers command: restores exact stashed stamps & colours.
    Restore {
        resources: PageNumbersResources,
        stamps: HashMap<u64, PageNumberStamp>,
        padding_numbers: HashMap<u64, PaddingPageNumber>,
    },
}

impl PageNumbersPlan {
    fn resources(&self) -> Option<&PageNumbersResources> {
        match self {
            Self::None => None,
            Self::Compute { resources, .. }
            | Self::Preserve { resources, .. }
            | Self::Restore { resources, .. } => Some(resources),
        }
    }

    pub(super) fn is_some(&self) -> bool {
        !matches!(self, Self::None)
    }
}

pub(super) fn rotated_watermark_object<'a>(
    document: &PdfDocument<'a>,
    font: PdfFontToken,
    text: &str,
    font_size: f32,
    color: PdfColor,
    object_rotation: f32,
) -> Result<PdfPageTextObject<'a>, String> {
    let mut object = PdfPageTextObject::new(document, text, font, PdfPoints::new(font_size))
        .map_err(|error| format!("PDFium rejected the watermark text: {error}"))?;

    object
        .set_fill_color(color)
        .map_err(|error| format!("PDFium rejected the watermark colour: {error}"))?;
    object
        .rotate_clockwise_degrees(object_rotation)
        .map_err(|error| format!("PDFium could not rotate the watermark: {error}"))?;

    Ok(object)
}

/// The rotated mark's bounding box in unrotated page space, at `font_size`.
pub(super) fn measured_watermark_size(
    document: &PdfDocument<'_>,
    font: PdfFontToken,
    text: &str,
    font_size: f32,
    color: PdfColor,
    object_rotation: f32,
) -> Result<(f32, f32), String> {
    let object = rotated_watermark_object(document, font, text, font_size, color, object_rotation)?;
    let bounds = object
        .bounds()
        .map_err(|error| format!("PDFium could not measure the watermark: {error}"))?;

    Ok((
        bounds.right().value - bounds.left().value,
        bounds.top().value - bounds.bottom().value,
    ))
}

/// Scales the mark so its displayed width is the share of the page the reader
/// chose; measured twice, so the zebra grid steps by the box really drawn.
pub(super) fn watermark_metrics(
    document: &PdfDocument<'_>,
    font: PdfFontToken,
    config: &WatermarkConfig,
    color: PdfColor,
    page_rotation: f32,
    page_width: f32,
    page_height: f32,
) -> Result<WatermarkMetrics, String> {
    // `/Rotate` 90 and 270 swap the axes: the width the reader sees — and the
    // axis the mark's measured box spans — is the unrotated height.
    let quarter_turned = page_rotation == 90.0 || page_rotation == 270.0;
    let (display_width, display_height) = if quarter_turned {
        (page_height, page_width)
    } else {
        (page_width, page_height)
    };
    let object_rotation =
        watermark_rotation(config.direction, display_width, display_height)? - page_rotation;
    let reference = measured_watermark_size(
        document,
        font,
        &config.text,
        WATERMARK_REFERENCE_FONT_SIZE,
        color,
        object_rotation,
    )?;
    let measured_width = if quarter_turned {
        reference.1
    } else {
        reference.0
    };
    let font_size = watermark_font_size(config.width_ratio, display_width, measured_width)?;
    let (text_width, text_height) = measured_watermark_size(
        document,
        font,
        &config.text,
        font_size,
        color,
        object_rotation,
    )?;

    Ok(WatermarkMetrics {
        object_rotation,
        font_size,
        text_width,
        text_height,
    })
}

pub(super) fn rotated_page_number_object<'a>(
    document: &PdfDocument<'a>,
    font: PdfFontToken,
    text: &str,
    color: PdfColor,
    object_rotation: f32,
) -> Result<PdfPageTextObject<'a>, String> {
    let mut object =
        PdfPageTextObject::new(document, text, font, PdfPoints::new(PAGE_NUMBER_FONT_SIZE))
            .map_err(|error| format!("PDFium rejected the page-number text: {error}"))?;

    object
        .set_fill_color(color)
        .map_err(|error| format!("PDFium rejected the page-number colour: {error}"))?;
    object
        .rotate_clockwise_degrees(object_rotation)
        .map_err(|error| format!("PDFium could not rotate the page number: {error}"))?;

    Ok(object)
}

pub(super) fn place_text_object<'a>(
    mut object: PdfPageTextObject<'a>,
    target_x: f32,
    target_y: f32,
) -> Result<PdfPageTextObject<'a>, String> {
    let bounds = object
        .bounds()
        .map_err(|error| format!("PDFium could not measure an owned object: {error}"))?;
    let center_x = (bounds.left().value + bounds.right().value) / 2.0;
    let center_y = (bounds.bottom().value + bounds.top().value) / 2.0;

    object
        .translate(
            PdfPoints::new(target_x - center_x),
            PdfPoints::new(target_y - center_y),
        )
        .map_err(|error| format!("PDFium could not place an owned object: {error}"))?;

    Ok(object)
}

/// Stamps one page-number label onto a freshly created blank padding sheet.
pub(super) fn stamp_page_number_on_blank(
    document: &mut PdfDocument<'_>,
    page_index: PdfPageIndex,
    font: PdfFontToken,
    number: &PaddingPageNumber,
) -> Result<(), String> {
    let page_rotation = {
        let page = document
            .pages()
            .get(page_index)
            .map_err(|error| format!("PDFium could not load the blank page: {error}"))?;
        page_rotation_degrees(&page)
    };

    PdfiumEngine::append_page_number(
        document,
        page_index,
        font,
        number.text.clone(),
        number.anchor,
        page_rotation,
        Some(PdfColor::BLACK),
    )?;

    Ok(())
}

/// What a stopped or failed rebuild leaves behind.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RebuildFailure {
    /// The document as it was, from a snapshot taken first.
    RollBack,
    /// Whatever it reached: a copy its caller throws away needs no snapshot.
    Discard,
}

impl PdfiumEngine {
    /// Whole-document preflight, run before anything is touched: every page
    /// must still end with exactly the objects this session recorded. It holds
    /// the PDFium lock for the whole walk, so a guard makes it stoppable
    /// between pages — `Ok(false)` — and each page is reported as it passes.
    pub(super) fn verify_owned_tail(
        document: &PdfDocument<'static>,
        page_ids: &[u64],
        state: &OwnedContentState,
        operation: Option<&OperationGuard<'_>>,
        on_progress: &mut dyn FnMut(usize, usize),
    ) -> Result<bool, String> {
        let page_count = document.pages().len();

        // `page_ids` is the engine's own mirror of the page list; drifted from
        // the document, every id-keyed record below would name the wrong pages.
        if page_ids.len() != page_count as usize {
            return Err("the owned-content record does not cover every page".into());
        }

        if state.per_page.len() != page_ids.len() {
            return Err("the owned-content record does not cover every page".into());
        }

        for (index, page_id) in page_ids.iter().enumerate() {
            if operation.is_some_and(OperationGuard::is_cancelled) {
                return Ok(false);
            }

            on_progress(index, page_ids.len());

            let page_number = index as i32 + 1;
            let tail = state
                .per_page
                .get(page_id)
                .ok_or_else(|| format!("the owned-content record is missing page {page_number}"))?;
            let expected = tail
                .base_objects
                .checked_add(tail.owned_objects())
                .ok_or_else(|| "the owned object count overflowed".to_string())?;
            let page = document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let objects = page.objects();

            if objects.len() != expected {
                return Err(format!(
                    "page {page_number}'s content no longer ends where this session's marks should"
                ));
            }

            // A page inserted or merged after a layer was applied owns nothing:
            // its count is pinned above, and there is no tail to identify.
            if tail.segments.is_empty() {
                continue;
            }

            let text_page = page
                .text()
                .map_err(|error| format!("PDFium could not inspect page {page_number}: {error}"))?;
            let mut next = tail.base_objects;

            for segment in &tail.segments {
                for (offset, identity) in segment.identities.iter().enumerate() {
                    let object = objects.get(next + offset).map_err(|error| {
                        format!(
                            "PDFium could not inspect owned object {}: {error}",
                            next + offset
                        )
                    })?;
                    let text_object = object.as_text_object().ok_or_else(|| {
                        format!("page {page_number}'s owned tail contains a non-text object")
                    })?;
                    // PDFium's extraction appends a separator to a run another
                    // follows on one line; apply trimmed its identities the same.
                    let actual = text_page.for_object(text_object).trim().to_owned();

                    if actual != *identity {
                        return Err(format!(
                            "page {page_number}'s owned tail contains different text"
                        ));
                    }
                }

                next += segment.object_count;
            }
        }

        on_progress(page_ids.len(), page_ids.len());

        Ok(true)
    }

    /// Stamps layers on a document nobody holds yet, as content of its own
    /// rather than this session's: the file written from it reads as an open
    /// of that file would, saved over without refusal. `false` is a stopped run.
    /// Such a document is the caller's to throw away on a failure or a stop,
    /// so nothing is kept to roll it back.
    pub(super) fn stamp_layers(
        &self,
        document_id: u64,
        watermark: Option<WatermarkResources>,
        page_numbers: PageNumbersPlan,
        on_progress: &mut dyn FnMut(usize, usize),
        operation: &OperationGuard<'_>,
    ) -> Result<bool, String> {
        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(false);
        }

        let entry = open_entry_mut(&mut documents, document_id)?;

        if !self.rebuild_owned_content(
            entry,
            watermark,
            page_numbers,
            on_progress,
            operation,
            RebuildFailure::Discard,
        )? {
            return Ok(false);
        }

        entry.owned_content = None;

        Ok(true)
    }

    /// A copy of the document whose pages still end in this session's
    /// watermark and page numbers as recorded, and how many objects each page's
    /// take: for work that lifts them a page at a time (`lift_owned_tail`) and
    /// lays the pages out afresh. `None` with no layer on, or where the tails no
    /// longer end the pages as recorded, and the layers then go along as page
    /// content. Under the lock; a stop ends the check.
    pub(super) fn layered_copy(
        &self,
        entry: &OpenDocument,
        operation: &OperationGuard<'_>,
    ) -> Result<Option<(PdfDocument<'static>, Vec<usize>)>, String> {
        let Some(state) = entry
            .owned_content
            .as_ref()
            .filter(|state| state.has_active_layer())
        else {
            return Ok(None);
        };
        let bytes = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not copy the document: {error}"))?;
        let mut copy = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reread the document: {error}"))?;

        if !matches!(
            Self::verify_owned_tail(
                &copy,
                &entry.page_ids,
                state,
                Some(operation),
                &mut |_, _| {}
            ),
            Ok(true)
        ) {
            return Ok(None);
        }

        // Past the last page: lifted objects wait there to go with the copy.
        copy.pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .map_err(|error| format!("PDFium could not create a scratch page: {error}"))?;

        let owned = entry
            .page_ids
            .iter()
            .map(|page_id| {
                state
                    .per_page
                    .get(page_id)
                    .map(OwnedTailState::owned_objects)
                    .unwrap_or(0)
            })
            .collect();

        Ok(Some((copy, owned)))
    }

    /// Takes the last `owned` objects off page `index` of a `layered_copy`.
    pub(super) fn lift_owned_tail(
        copy: &mut PdfDocument<'static>,
        index: usize,
        owned: usize,
    ) -> Result<(), String> {
        if owned == 0 {
            return Ok(());
        }

        let bin = copy.pages().len() - 1;
        let mut page = copy
            .pages_mut()
            .get(index as PdfPageIndex)
            .map_err(|error| format!("PDFium could not load page {}: {error}", index + 1))?;
        let mut retired = Vec::with_capacity(owned);

        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        for _ in 0..owned {
            let last = page
                .objects()
                .len()
                .checked_sub(1)
                .ok_or_else(|| "a page's watermark or number went missing".to_string())?;

            retired.push(
                page.objects_mut()
                    .remove_object_at_index(last)
                    .map_err(|error| {
                        format!("PDFium could not lift the watermark or number: {error}")
                    })?,
            );
        }

        page.regenerate_content()
            .map_err(|error| format!("PDFium could not regenerate the page: {error}"))?;
        drop(page);

        Self::retire_owned_objects(copy, bin, retired)
    }

    /// A layer change's two walks as one run of progress — the tails checked
    /// once, then rebuilt in two passes — and one stop for either: nothing is
    /// touched until the check has passed, and the rebuild rolls itself back.
    fn verify_and_rebuild(
        &self,
        entry: &mut OpenDocument,
        watermark: Option<WatermarkResources>,
        page_numbers: PageNumbersPlan,
        on_progress: &mut dyn FnMut(usize, usize),
        operation: &OperationGuard<'_>,
    ) -> Result<bool, String> {
        let pages = entry.page_ids.len();
        let checked = match &entry.owned_content {
            Some(state) => {
                let verified = Self::verify_owned_tail(
                    &entry.document,
                    &entry.page_ids,
                    state,
                    Some(operation),
                    &mut |done, _| on_progress(done, pages * 3),
                )?;

                if !verified {
                    return Ok(false);
                }

                pages
            }
            None => 0,
        };

        self.rebuild_owned_content(
            entry,
            watermark,
            page_numbers,
            &mut |done, total| on_progress(checked + done, checked + total),
            operation,
            RebuildFailure::RollBack,
        )
    }

    /// Reads back a just-written tail's identities, so a later guard compares
    /// what PDFium holds, not source text an embedded font may have remapped.
    pub(super) fn read_owned_tail(
        document: &PdfDocument<'static>,
        page_number: i32,
        base_objects: usize,
        segment_counts: &[usize],
    ) -> Result<OwnedTailState, String> {
        let page = document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let objects = page.objects();
        let text_page = page
            .text()
            .map_err(|error| format!("PDFium could not inspect page {page_number}: {error}"))?;
        let mut segments = Vec::with_capacity(segment_counts.len());
        let mut next = base_objects;

        for &count in segment_counts {
            let mut identities = Vec::with_capacity(count);

            for offset in 0..count {
                let object = objects.get(next + offset).map_err(|error| {
                    format!(
                        "PDFium could not inspect owned object {}: {error}",
                        next + offset
                    )
                })?;
                let text_object = object.as_text_object().ok_or_else(|| {
                    format!("page {page_number}'s owned tail contains a non-text object")
                })?;

                identities.push(text_page.for_object(text_object).trim().to_owned());
            }

            segments.push(OwnedSegment {
                object_count: count,
                identities,
            });
            next += count;
        }

        Ok(OwnedTailState {
            base_objects,
            segments,
        })
    }

    /// Plans every page's base object count and watermark placements before
    /// any page is touched, so a planning failure leaves the document untouched.
    /// Blank-page detection and page-number placement run in the rebuild pass,
    /// after each page's old owned tail has been popped.
    pub(super) fn plan_owned_content(
        entry: &OpenDocument,
        watermark: Option<(&WatermarkConfig, PdfFontToken, PdfColor)>,
        on_progress: &mut dyn FnMut(usize, usize),
        operation: &OperationGuard<'_>,
    ) -> Result<Option<Vec<PageOwnedPlan>>, String> {
        let page_count = entry.document.pages().len();

        // Without this an empty document takes an empty ownership record the
        // guards pass vacuously — a session that refuses to save over nothing.
        if page_count < 1 {
            return Err("a document with no pages cannot carry page marks".into());
        }

        let previous = entry.owned_content.as_ref();
        let mut plans = Vec::with_capacity(page_count as usize);
        let mut measured_metrics: Vec<((u32, u32, u32), WatermarkMetrics)> = Vec::new();
        let mut document_objects = 0usize;

        for page_number in 1..=page_count {
            if operation.is_cancelled() {
                return Ok(None);
            }

            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            let base_objects = match previous {
                Some(state) => {
                    state
                        .per_page
                        .get(&entry.page_id(page_number)?)
                        .ok_or_else(|| {
                            format!("the owned-content record is missing page {page_number}")
                        })?
                        .base_objects
                }
                None => page.objects().len(),
            };

            let watermark_plan = match watermark {
                Some((config, font, color)) => {
                    let page_rotation = page_rotation_degrees(&page);
                    let (page_width, page_height) = unrotated_page_size(&page);
                    // The mark follows the page box alone, so pages of one size
                    // measure the same, and a geometry-keyed cache holds.
                    let key = (
                        page_rotation.to_bits(),
                        page_width.to_bits(),
                        page_height.to_bits(),
                    );
                    let metrics = match measured_metrics.iter().find(|(cached, _)| *cached == key) {
                        Some((_, metrics)) => *metrics,
                        None => {
                            let metrics = watermark_metrics(
                                &entry.document,
                                font,
                                config,
                                color,
                                page_rotation,
                                page_width,
                                page_height,
                            )?;

                            measured_metrics.push((key, metrics));
                            metrics
                        }
                    };
                    let placements = watermark_placements(
                        page_width,
                        page_height,
                        metrics.text_width,
                        metrics.text_height,
                        watermark_zebra_spacing(metrics.font_size),
                        config.layout,
                    )?;

                    document_objects =
                        add_document_object_count(document_objects, placements.len())?;

                    Some(WatermarkLayerPlan {
                        object_rotation: metrics.object_rotation,
                        font_size: metrics.font_size,
                        placements,
                    })
                }
                None => None,
            };

            plans.push(PageOwnedPlan {
                base_objects,
                page_number,
                watermark: watermark_plan,
            });
            on_progress(page_number as usize, page_count as usize * 2);
        }

        Ok(Some(plans))
    }

    /// A coarse whole-page render under the viewer's ceilings, annotations
    /// drawn — every sampler asks what the reader sees. Callers check dimensions.
    pub(super) fn render_page_sample(
        page: &PdfPage<'_>,
        dpi: f32,
    ) -> Result<DynamicImage, PdfiumError> {
        let display_width = page.width().value;
        let display_height = page.height().value;
        let scale = (dpi / POINTS_PER_INCH)
            .min(MAX_RENDER_WIDTH as f32 / display_width)
            .min(MAX_RENDER_HEIGHT as f32 / display_height);
        let render_width = (display_width * scale)
            .round()
            .clamp(1.0, MAX_RENDER_WIDTH as f32) as i32;
        let config = PdfRenderConfig::new()
            .set_target_width(render_width)
            .set_maximum_width(MAX_RENDER_WIDTH)
            .set_maximum_height(MAX_RENDER_HEIGHT)
            .render_annotations(true)
            .render_form_data(true);

        page.render_with_config(&config)
            .and_then(|bitmap| bitmap.as_image())
    }

    /// Scans the whole visible page after this session's old owned tail has
    /// been popped, so neither a watermark nor a rotated label hides a blank
    /// page and content near the bottom edge still counts.
    pub(super) fn page_is_blank(page: &PdfPage<'_>) -> Result<bool, String> {
        let display_width = page.width().value;
        let display_height = page.height().value;

        if !display_width.is_finite()
            || !display_height.is_finite()
            || display_width <= 0.0
            || display_height <= 0.0
        {
            return Ok(false);
        }

        let rendered = Self::render_page_sample(page, PAGE_BLANK_SCAN_DPI)
            .map_err(|error| format!("PDFium could not sample a page for blankness: {error}"))?;
        let sample = rendered.into_rgba8().into_raw();

        Ok(is_blank_sample(&sample))
    }

    /// The ink that stays legible on the drop a page number will cover; a page
    /// with no usable dimensions, or a region off the render, defaults to black.
    pub(super) fn sample_ink_color(
        page: &PdfPage<'_>,
        region: DisplayBox,
    ) -> Result<PdfColor, String> {
        let display_width = page.width().value;
        let display_height = page.height().value;

        if !display_width.is_finite()
            || !display_height.is_finite()
            || display_width <= 0.0
            || display_height <= 0.0
        {
            return Ok(PdfColor::BLACK);
        }

        // The decision is a single average, so a handful of pixels across the
        // label suffices — far cheaper than a print-resolution capture.
        let rendered = Self::render_page_sample(page, PAGE_NUMBER_SAMPLE_DPI)
            .map_err(|error| format!("PDFium could not sample a page for smart colour: {error}"))?;

        let scale_x = rendered.width() as f32 / display_width;
        let scale_y = rendered.height() as f32 / display_height;
        let left = ((region.left - PAGE_NUMBER_SAMPLE_PADDING) * scale_x)
            .floor()
            .max(0.0) as u32;
        let top = ((region.top - PAGE_NUMBER_SAMPLE_PADDING) * scale_y)
            .floor()
            .max(0.0) as u32;
        let right = ((region.left + region.width + PAGE_NUMBER_SAMPLE_PADDING) * scale_x)
            .ceil()
            .min(rendered.width() as f32) as u32;
        let bottom = ((region.top + region.height + PAGE_NUMBER_SAMPLE_PADDING) * scale_y)
            .ceil()
            .min(rendered.height() as f32) as u32;

        if right <= left || bottom <= top {
            return Ok(PdfColor::BLACK);
        }

        let crop = rendered
            .crop_imm(left, top, right - left, bottom - top)
            .into_rgba8()
            .into_raw();

        PdfColor::from_hex(ink_color(average_luminance(&crop)))
            .map_err(|error| format!("PDFium rejected the page-number colour: {error}"))
    }

    pub(super) fn restore_document_snapshot(
        &self,
        entry: &mut OpenDocument,
        snapshot: Vec<u8>,
        cause: String,
    ) -> String {
        match self.load_document_snapshot(entry, snapshot) {
            Ok(()) => cause,
            Err(error) => format!(
                "{cause}; PDFium also could not roll the document back to its previous bytes: {error}"
            ),
        }
    }

    pub(super) fn load_document_snapshot(
        &self,
        entry: &mut OpenDocument,
        snapshot: Vec<u8>,
    ) -> Result<(), String> {
        match self.pdfium.load_pdf_from_byte_vec(snapshot, None) {
            Ok(document) => {
                entry.document = document;
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    /// pdfium-render 0.9.3 double-destroys a dropped removed object, so retired
    /// ones reattach to a scratch page whose delete hands cleanup to PDFium.
    pub(super) fn retire_owned_objects(
        document: &mut PdfDocument<'static>,
        scratch_index: i32,
        objects: Vec<PdfPageObject<'static>>,
    ) -> Result<(), String> {
        if objects.is_empty() {
            return Ok(());
        }

        let mut scratch = document
            .pages_mut()
            .get(scratch_index)
            .map_err(|error| format!("PDFium could not load the scratch page: {error}"))?;
        scratch.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        for object in objects {
            scratch
                .objects_mut()
                .add_object(object)
                .map_err(|error| format!("PDFium could not retire an old owned object: {error}"))?;
        }

        Ok(())
    }

    /// Pops `previous_tail` owned objects into `retired` and appends
    /// `watermark_objects` in one manual-regeneration pass.
    fn pop_and_lay_watermark(
        document: &mut PdfDocument<'static>,
        page_index: PdfPageIndex,
        previous_tail: usize,
        watermark_objects: Vec<PdfPageTextObject<'static>>,
        retired: &mut Vec<PdfPageObject<'static>>,
    ) -> Result<(), String> {
        if previous_tail == 0 && watermark_objects.is_empty() {
            return Ok(());
        }

        let mut page = document
            .pages_mut()
            .get(page_index)
            .map_err(|error| format!("PDFium could not load page {}: {error}", page_index + 1))?;
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        let mut changed = false;
        let mut change_error = None;

        {
            let objects = page.objects_mut();

            for _ in 0..previous_tail {
                let Some(last) = objects.len().checked_sub(1) else {
                    change_error = Some("the owned tail disappeared during a rebuild".to_string());
                    break;
                };

                match objects.remove_object_at_index(last) {
                    Ok(object) => {
                        retired.push(object);
                        changed = true;
                    }
                    Err(error) => {
                        change_error = Some(format!(
                            "PDFium could not remove the old owned content: {error}"
                        ));
                        break;
                    }
                }
            }
        }

        if change_error.is_none() {
            for object in watermark_objects {
                match page.objects_mut().add_text_object(object) {
                    Ok(_) => changed = true,
                    Err(error) => {
                        change_error =
                            Some(format!("PDFium could not append the watermark: {error}"));
                        break;
                    }
                }
            }
        }

        // Regenerated before the handle closes: PDFium drops inserted-but-unflushed
        // objects when the page is reopened.
        if changed && change_error.is_none() {
            if let Err(error) = page.regenerate_content() {
                change_error = Some(format!("PDFium could not regenerate the page: {error}"));
            }
        }

        page.set_content_regeneration_strategy(
            PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
        );

        match change_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Measures, samples smart colour when `color` is `None`, places, and
    /// appends one page-number object on `page_index`.
    fn append_page_number<'a>(
        document: &mut PdfDocument<'a>,
        page_index: PdfPageIndex,
        font: PdfFontToken,
        text: String,
        anchor: PageNumberAnchor,
        placement_rotation: f32,
        color: Option<PdfColor>,
    ) -> Result<PageNumberStamp, String> {
        let page_number = page_index + 1;
        let (origin_x, origin_y, visible_width, visible_height, current_rotation) = {
            let page = document
                .pages()
                .get(page_index)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let (origin_x, origin_y, visible_width, visible_height) = visible_unrotated_box(&page);

            (
                origin_x,
                origin_y,
                visible_width,
                visible_height,
                page_rotation_degrees(&page),
            )
        };
        let object_rotation = -placement_rotation;
        // Measured exactly as it will be built, so placement and the
        // smart-colour drop both use real bounds.
        let measured = rotated_page_number_object(
            document,
            font,
            &text,
            color.unwrap_or(PdfColor::BLACK),
            object_rotation,
        )?;
        let bounds = measured
            .bounds()
            .map_err(|error| format!("PDFium could not measure a page number: {error}"))?;
        let bounds_width = bounds.right().value - bounds.left().value;
        let bounds_height = bounds.top().value - bounds.bottom().value;

        let center = page_number_center_in_box(
            origin_x,
            origin_y,
            visible_width,
            visible_height,
            placement_rotation,
            bounds_width,
            bounds_height,
            anchor,
        );
        let (ink, object) = match color {
            Some(fixed) => (fixed, measured),
            None => {
                drop(measured);
                let region = page_number_display_box(
                    visible_width,
                    visible_height,
                    current_rotation,
                    bounds_width,
                    bounds_height,
                    anchor,
                );
                let sampled = {
                    let page = document.pages().get(page_index).map_err(|error| {
                        format!("PDFium could not load page {page_number}: {error}")
                    })?;

                    Self::sample_ink_color(&page, region)?
                };

                (
                    sampled,
                    rotated_page_number_object(document, font, &text, sampled, object_rotation)?,
                )
            }
        };
        let object = place_text_object(object, center.center_x, center.center_y)?;

        let mut page = document
            .pages_mut()
            .get(page_index)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);

        let append_result = page
            .objects_mut()
            .add_text_object(object)
            .map_err(|error| format!("PDFium could not append the page number: {error}"))
            .and_then(|_| {
                page.regenerate_content()
                    .map_err(|error| format!("PDFium could not regenerate the page: {error}"))
            });
        page.set_content_regeneration_strategy(
            PdfPageContentRegenerationStrategy::AutomaticOnEveryChange,
        );
        append_result?;

        Ok(PageNumberStamp {
            text,
            anchor,
            color: ink,
            page_rotation: placement_rotation,
        })
    }

    /// Rebuilds every owned tail in the fixed layer order (`add_object` only
    /// appends, so this keeps the stack canonical); `false` is a stopped rebuild.
    pub(super) fn rebuild_owned_content(
        &self,
        entry: &mut OpenDocument,
        watermark: Option<WatermarkResources>,
        page_numbers: PageNumbersPlan,
        on_progress: &mut dyn FnMut(usize, usize),
        operation: &OperationGuard<'_>,
        on_failure: RebuildFailure,
    ) -> Result<bool, String> {
        let page_count = entry.document.pages().len() as usize;
        let total = page_count * 2;
        on_progress(0, total);

        // Nothing is touched yet, so an arrived stop costs neither the snapshot
        // below — a 17 MB serialization — nor a rollback.
        if operation.is_cancelled() {
            return Ok(false);
        }

        let version_before = entry.content_version;
        let previous = entry.owned_content.clone();
        let previous_pn_version = previous
            .as_ref()
            .and_then(|state| state.page_numbers_version);
        let snapshot = match on_failure {
            RebuildFailure::RollBack => Some(
                entry
                    .document
                    .save_to_bytes()
                    .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?,
            ),
            RebuildFailure::Discard => None,
        };

        // `None` is the reader's stop: the rollback below is the same one a
        // failure takes, so a stopped run leaves the document it started on.
        let rebuilt = (|| -> Result<Option<OwnedContentState>, String> {
            // Each layer's font loads once and threads through the loop; even
            // an unchanged layer reloads, since its objects are rebuilt too.
            let watermark_font = match &watermark {
                Some(resources) => Some(match &resources.embedded {
                    Some(bytes) => entry
                        .document
                        .fonts_mut()
                        .load_true_type_from_bytes(bytes, true)
                        .map_err(|error| {
                            format!("PDFium rejected the watermark's font: {error}")
                        })?,
                    // Latin-1 text needs no embedded face: the mark is always
                    // drawn in PDF's own sans, which every reader already has.
                    None => entry.document.fonts_mut().helvetica(),
                }),
                None => None,
            };
            let page_number_font = match page_numbers.resources() {
                Some(resources) => Some(
                    entry
                        .document
                        .fonts_mut()
                        .load_true_type_from_bytes(&resources.face, true)
                        .map_err(|error| {
                            format!("PDFium rejected the page-number font: {error}")
                        })?,
                ),
                None => None,
            };

            let Some(plans) = Self::plan_owned_content(
                entry,
                watermark
                    .as_ref()
                    .map(|resources| (&resources.config, watermark_font.unwrap(), resources.color)),
                on_progress,
                operation,
            )?
            else {
                return Ok(None);
            };

            // The scratch page receives retired objects; created only when a
            // prior tail exists, deleted before the end so PDFium collects them.
            let scratch_index = if previous.is_some() {
                let index = entry.document.pages().len();
                let scratch = entry
                    .document
                    .pages_mut()
                    .create_page_at_end(PdfPagePaperSize::a4())
                    .map_err(|error| format!("PDFium could not create a scratch page: {error}"))?;
                drop(scratch);
                Some(index)
            } else {
                None
            };

            let planned_pages = plans.len();
            let mut per_page = HashMap::with_capacity(planned_pages);
            let mut page_number_stamps = HashMap::new();
            let mut padding_numbers = match &page_numbers {
                PageNumbersPlan::Preserve {
                    padding_numbers, ..
                }
                | PageNumbersPlan::Restore {
                    padding_numbers, ..
                } => {
                    let live: HashSet<u64> = entry.page_ids.iter().copied().collect();
                    padding_numbers
                        .iter()
                        .filter(|(page_id, _)| live.contains(page_id))
                        .map(|(page_id, number)| (*page_id, number.clone()))
                        .collect()
                }
                PageNumbersPlan::Compute { .. } | PageNumbersPlan::None => HashMap::new(),
            };
            let padding_set: HashSet<usize> = match &page_numbers {
                PageNumbersPlan::Compute { padding, .. } => padding.iter().copied().collect(),
                _ => HashSet::new(),
            };
            // The sequence is walked in Pass 2 after popping each page's old
            // tail, counting virtual padding blanks alongside real pages.
            let mut numbering = match &page_numbers {
                PageNumbersPlan::Compute { resources, padding } => {
                    let range_from = resources.config.range_from();
                    let padding_before = if resources.config.blank_counted {
                        padding
                            .iter()
                            .filter(|&&after| after + 1 < range_from as usize)
                            .count() as i32
                    } else {
                        0
                    };

                    Some(PageNumbering::new_from(
                        &resources.config,
                        range_from + padding_before,
                    ))
                }
                _ => None,
            };
            let mut sheet_number = 0i32;

            for (index, plan) in plans.into_iter().enumerate() {
                // Between pages, never inside one: a page keeps a whole tail or
                // none, and the snapshot puts back the pages already rebuilt.
                if operation.is_cancelled() {
                    return Ok(None);
                }

                let page_id = entry.page_id(plan.page_number)?;
                let page_index = plan.page_number - 1;

                // Watermark objects built up front, so a failure leaves the page
                // untouched; the page-number object waits until its drop is real.
                let mut watermark_objects: Vec<PdfPageTextObject<'static>> = Vec::new();
                if let Some(layer) = &plan.watermark {
                    let resources = watermark
                        .as_ref()
                        .expect("a watermark plan implies watermark resources");
                    let font = watermark_font.expect("a watermark plan implies a loaded font");
                    watermark_objects.reserve(layer.placements.len());

                    for placement in &layer.placements {
                        let object = rotated_watermark_object(
                            &entry.document,
                            font,
                            &resources.config.text,
                            layer.font_size,
                            resources.color,
                            layer.object_rotation,
                        )?;
                        watermark_objects.push(place_text_object(
                            object,
                            placement.center_x,
                            placement.center_y,
                        )?);
                    }
                }

                let previous_tail = previous
                    .as_ref()
                    .and_then(|state| state.per_page.get(&page_id))
                    .map(OwnedTailState::owned_objects)
                    .unwrap_or(0);
                let need_blank_scan = match &page_numbers {
                    PageNumbersPlan::Compute { resources, .. } => {
                        resources.config.needs_blank_scan()
                            && resources.config.covers(plan.page_number)
                    }
                    _ => false,
                };

                let mut retired = Vec::new();
                let page_result = (|| -> Result<Option<PageNumberStamp>, String> {
                    let blank = if need_blank_scan {
                        let empty_base = {
                            let page = entry.document.pages().get(page_index).map_err(|error| {
                                format!("PDFium could not load page {}: {error}", plan.page_number)
                            })?;
                            plan.base_objects == 0 && page.annotations().is_empty()
                        };

                        if empty_base {
                            Self::pop_and_lay_watermark(
                                &mut entry.document,
                                page_index,
                                previous_tail,
                                watermark_objects,
                                &mut retired,
                            )?;
                            true
                        } else {
                            // Pop the old tail and flush before scanning, so
                            // neither an old watermark nor a rotated old label
                            // disguises a blank page.
                            if previous_tail > 0 {
                                Self::pop_and_lay_watermark(
                                    &mut entry.document,
                                    page_index,
                                    previous_tail,
                                    Vec::new(),
                                    &mut retired,
                                )?;
                            }

                            let is_blank = {
                                let page =
                                    entry.document.pages().get(page_index).map_err(|error| {
                                        format!(
                                            "PDFium could not load page {}: {error}",
                                            plan.page_number
                                        )
                                    })?;
                                Self::page_is_blank(&page)?
                            };

                            if !watermark_objects.is_empty() {
                                Self::pop_and_lay_watermark(
                                    &mut entry.document,
                                    page_index,
                                    0,
                                    watermark_objects,
                                    &mut retired,
                                )?;
                            }

                            is_blank
                        }
                    } else {
                        Self::pop_and_lay_watermark(
                            &mut entry.document,
                            page_index,
                            previous_tail,
                            watermark_objects,
                            &mut retired,
                        )?;
                        false
                    };

                    match &page_numbers {
                        PageNumbersPlan::Compute { resources, .. } => {
                            let numbering = numbering
                                .as_mut()
                                .expect("a compute plan implies a numbering walk");
                            sheet_number += 1;
                            let page_sheet = sheet_number;
                            let printed = numbering.advance(plan.page_number, blank);

                            if padding_set.contains(&index) {
                                sheet_number += 1;
                                let padding_sheet = sheet_number;
                                if let Some(text) = numbering.advance_padding(plan.page_number) {
                                    padding_numbers.insert(
                                        page_id,
                                        PaddingPageNumber {
                                            text,
                                            anchor: resources.config.anchor(padding_sheet),
                                        },
                                    );
                                }
                            }

                            let Some(text) = printed else {
                                return Ok(None);
                            };
                            let page_rotation = {
                                let page =
                                    entry.document.pages().get(page_index).map_err(|error| {
                                        format!(
                                            "PDFium could not load page {}: {error}",
                                            plan.page_number
                                        )
                                    })?;
                                page_rotation_degrees(&page)
                            };
                            let font =
                                page_number_font.expect("a page-number plan implies a loaded font");
                            let anchor = resources.config.anchor(page_sheet);
                            let fixed_color =
                                (!resources.config.smart_color()).then_some(PdfColor::BLACK);

                            Self::append_page_number(
                                &mut entry.document,
                                page_index,
                                font,
                                text,
                                anchor,
                                page_rotation,
                                fixed_color,
                            )
                            .map(Some)
                        }
                        PageNumbersPlan::Preserve {
                            resources,
                            stamps,
                            resample_color,
                            ..
                        } => {
                            let Some(stamp) = stamps.get(&page_id) else {
                                return Ok(None);
                            };
                            let current_rotation = {
                                let page =
                                    entry.document.pages().get(page_index).map_err(|error| {
                                        format!(
                                            "PDFium could not load page {}: {error}",
                                            plan.page_number
                                        )
                                    })?;
                                page_rotation_degrees(&page)
                            };
                            let font =
                                page_number_font.expect("a page-number plan implies a loaded font");
                            let fixed_color = if *resample_color
                                && resources.config.smart_color()
                                && stamp.page_rotation == current_rotation
                            {
                                None
                            } else {
                                Some(stamp.color)
                            };

                            Self::append_page_number(
                                &mut entry.document,
                                page_index,
                                font,
                                stamp.text.clone(),
                                stamp.anchor,
                                stamp.page_rotation,
                                fixed_color,
                            )
                            .map(Some)
                        }
                        PageNumbersPlan::Restore { stamps, .. } => {
                            let Some(stamp) = stamps.get(&page_id) else {
                                return Ok(None);
                            };
                            let font =
                                page_number_font.expect("a page-number plan implies a loaded font");

                            Self::append_page_number(
                                &mut entry.document,
                                page_index,
                                font,
                                stamp.text.clone(),
                                stamp.anchor,
                                stamp.page_rotation,
                                Some(stamp.color),
                            )
                            .map(Some)
                        }
                        PageNumbersPlan::None => Ok(None),
                    }
                })();

                // Always reattach removed objects before propagating an error,
                // avoiding pdfium-render's double-destroy on loose drop.
                let retire_result = match scratch_index {
                    Some(scratch) => {
                        Self::retire_owned_objects(&mut entry.document, scratch, retired)
                    }
                    None => Ok(()),
                };
                let stamp = match (page_result, retire_result) {
                    (Ok(stamp), Ok(())) => stamp,
                    (Err(error), _) => return Err(error),
                    (Ok(_), Err(error)) => return Err(error),
                };

                let mut segment_counts = Vec::new();
                if let Some(layer) = &plan.watermark {
                    segment_counts.push(layer.placements.len());
                }
                if let Some(stamp) = stamp {
                    segment_counts.push(1);
                    page_number_stamps.insert(page_id, stamp);
                }

                let tail = Self::read_owned_tail(
                    &entry.document,
                    plan.page_number,
                    plan.base_objects,
                    &segment_counts,
                )?;

                per_page.insert(page_id, tail);

                let completed = planned_pages + index + 1;
                if completed < total {
                    on_progress(completed, total);
                }
            }

            if let Some(index) = scratch_index {
                entry
                    .document
                    .pages_mut()
                    .get(index)
                    .map_err(|error| format!("PDFium could not load the scratch page: {error}"))?
                    .delete()
                    .map_err(|error| {
                        format!("PDFium could not delete the scratch page: {error}")
                    })?;
            }

            Ok(Some(OwnedContentState {
                watermark: watermark.as_ref().map(|resources| resources.config.clone()),
                page_numbers: page_numbers
                    .resources()
                    .map(|resources| resources.config.clone()),
                per_page,
                page_number_stamps,
                padding_numbers,
                page_numbers_version: None,
            }))
        })();

        let mut state = match (rebuilt, snapshot) {
            (Ok(Some(state)), _) => state,
            // A stop is a failure only when the rollback itself fails — the one
            // case leaving a document neither reader nor session asked for.
            (Ok(None), Some(snapshot)) => {
                return match self.load_document_snapshot(entry, snapshot) {
                    Ok(()) => Ok(false),
                    Err(error) => Err(format!(
                        "the operation was stopped, but PDFium could not roll the document back to its previous bytes: {error}"
                    )),
                };
            }
            (Ok(None), None) => return Ok(false),
            (Err(error), Some(snapshot)) => {
                return Err(self.restore_document_snapshot(entry, snapshot, error));
            }
            (Err(error), None) => return Err(error),
        };

        // A rebuild that had something to pop leaves orphaned fonts and content
        // behind for the next save to collect; a first apply removes nothing.
        entry.needs_compaction |= previous.is_some();
        entry.invalidate_all_page_revisions();
        state.page_numbers_version = match &page_numbers {
            PageNumbersPlan::Compute { .. } => Some(entry.content_version),
            PageNumbersPlan::Preserve { .. } if previous_pn_version == Some(version_before) => {
                Some(entry.content_version)
            }
            PageNumbersPlan::Preserve { .. } => previous_pn_version,
            PageNumbersPlan::Restore { .. } | PageNumbersPlan::None => None,
        };
        entry.owned_content = if state.has_active_layer() {
            Some(state)
        } else {
            None
        };
        on_progress(total, total);

        Ok(true)
    }

    /// The rebuild inputs from a config. A *new* watermark's subset is cut
    /// outside the lock (pure CPU work); an existing layer's is taken under it.
    pub(super) fn watermark_resources(
        &self,
        config: &WatermarkConfig,
    ) -> Result<WatermarkResources, String> {
        let color = PdfColor::from_hex(WATERMARK_COLOR)
            .map_err(|error| format!("the watermark colour is unusable: {error}"))?
            .with_alpha((WATERMARK_OPACITY * 255.0).round() as u8);
        let embedded = if needs_embedded_font(&config.text) {
            Some(self.embedded_face_subset(&config.text)?)
        } else {
            None
        };

        Ok(WatermarkResources {
            config: config.clone(),
            color,
            embedded,
        })
    }

    /// The rebuild inputs from a config; the face is kilobytes and cached, so
    /// this is cheap enough to run under the lock.
    pub(super) fn page_numbers_resources(
        &self,
        config: &PageNumbersConfig,
    ) -> Result<PageNumbersResources, String> {
        Ok(PageNumbersResources {
            config: config.clone(),
            face: self.page_number_font_bytes()?.to_vec(),
        })
    }

    /// The page-number layer's current stamps as a preserve plan — what a
    /// watermark change passes so existing per-page numbers survive untouched
    /// while still resampling smart colour over the updated watermark.
    pub(super) fn existing_page_numbers(
        &self,
        entry: &OpenDocument,
    ) -> Result<PageNumbersPlan, String> {
        let Some(state) = entry.owned_content.as_ref() else {
            return Ok(PageNumbersPlan::None);
        };
        let Some(config) = state.page_numbers.as_ref() else {
            return Ok(PageNumbersPlan::None);
        };

        Ok(PageNumbersPlan::Preserve {
            resources: self.page_numbers_resources(config)?,
            stamps: state.page_number_stamps.clone(),
            padding_numbers: state.padding_numbers.clone(),
            resample_color: true,
        })
    }

    /// Maps the document's existing page-number stamps onto a fresh A4 copy's
    /// 0..N page ids, upright (`page_rotation = 0.0`) because fitting to A4
    /// already baked each source page's `/Rotate` into its form XObject.
    pub(super) fn a4_page_numbers(&self, entry: &OpenDocument) -> Result<PageNumbersPlan, String> {
        let Some(state) = entry.owned_content.as_ref() else {
            return Ok(PageNumbersPlan::None);
        };
        let Some(config) = state.page_numbers.as_ref() else {
            return Ok(PageNumbersPlan::None);
        };

        let mut stamps = HashMap::new();
        for (index, page_id) in entry.page_ids.iter().enumerate() {
            if let Some(stamp) = state.page_number_stamps.get(page_id) {
                let mut upright = stamp.clone();
                upright.page_rotation = 0.0;
                stamps.insert(index as u64, upright);
            }
        }

        Ok(PageNumbersPlan::Preserve {
            resources: self.page_numbers_resources(config)?,
            stamps,
            padding_numbers: HashMap::new(),
            resample_color: true,
        })
    }

    fn snapshot_page_numbers(entry: &OpenDocument) -> PageNumbersSnapshot {
        match entry.owned_content.as_ref() {
            Some(state) => PageNumbersSnapshot {
                config: state.page_numbers.clone(),
                stamps: state.page_number_stamps.clone(),
                padding_numbers: state.padding_numbers.clone(),
            },
            None => PageNumbersSnapshot {
                config: None,
                stamps: HashMap::new(),
                padding_numbers: HashMap::new(),
            },
        }
    }

    /// The watermark layer's resources from the current config, or `None` —
    /// what a page-number change passes so the other layer survives unchanged.
    pub(super) fn existing_watermark(
        &self,
        entry: &OpenDocument,
    ) -> Result<Option<WatermarkResources>, String> {
        match entry
            .owned_content
            .as_ref()
            .and_then(|state| state.watermark.clone())
        {
            Some(config) => Ok(Some(self.watermark_resources(&config)?)),
            None => Ok(None),
        }
    }

    pub fn apply_watermark_with_progress(
        &self,
        document_id: u64,
        config: WatermarkConfig,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let config = config.validated()?;

        // Listed before either lock wait — the no-op check below takes one too,
        // and behind another document's rebuild that is already a wait to abort.
        let operation = self.begin_operation(OperationTarget::Document(document_id));

        // Avoid a 17 MB read and subset for an exact no-op, while still checking
        // again under the commit lock in case another direct IPC raced this one.
        {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;

            if entry
                .owned_content
                .as_ref()
                .is_some_and(|state| state.watermark.as_ref() == Some(&config))
            {
                return Ok(true);
            }
        }

        if operation.is_cancelled() {
            return Ok(false);
        }

        let watermark = self.watermark_resources(&config)?;

        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(false);
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        if entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.watermark.as_ref() == Some(&config))
        {
            return Ok(true);
        }
        let page_numbers = self.existing_page_numbers(entry)?;

        self.verify_and_rebuild(
            entry,
            Some(watermark),
            page_numbers,
            &mut on_progress,
            &operation,
        )
    }

    #[cfg(test)]
    pub(super) fn apply_watermark(
        &self,
        document_id: u64,
        config: WatermarkConfig,
    ) -> Result<bool, String> {
        self.apply_watermark_with_progress(document_id, config, |_, _| {})
    }

    /// Removes only the watermark this open session owns, rebuilding any other
    /// owned layer's tail so it survives the change unaltered.
    pub fn remove_watermark_with_progress(
        &self,
        document_id: u64,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(false);
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        if !entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.watermark.is_some())
        {
            return Err("this session has no watermark to remove".into());
        }
        let page_numbers = self.existing_page_numbers(entry)?;

        self.verify_and_rebuild(entry, None, page_numbers, &mut on_progress, &operation)
    }

    #[cfg(test)]
    pub(super) fn remove_watermark(&self, document_id: u64) -> Result<bool, String> {
        self.remove_watermark_with_progress(document_id, |_, _| {})
    }

    /// Applies page numbers, rebuilding every owned layer's tail in canonical
    /// order, numbers on top; the range validates against the current length.
    /// When `stash_id` is given, snapshots the previous page-number state so
    /// undo can restore exact stamps via `restore_page_numbers_with_progress`.
    pub fn apply_page_numbers_with_progress(
        &self,
        document_id: u64,
        config: PageNumbersConfig,
        stash_id: Option<u64>,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<PageNumbersOutcome, String> {
        // Listed before the lock wait, so a rebuild queued behind another can be
        // stopped before it has run.
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(PageNumbersOutcome {
                applied: false,
                padding: Vec::new(),
            });
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;
        let config = config.validated(entry.page_ids.len() as i32)?;

        let previous_snapshot = stash_id.map(|_| Self::snapshot_page_numbers(entry));

        // Skip only when the exact config already stands on the current content
        // version: an insert, delete, rotation, or smart-padding toggle since
        // must renumber even under the same settings.
        if entry.owned_content.as_ref().is_some_and(|state| {
            state.page_numbers.as_ref() == Some(&config)
                && state.page_numbers_version == Some(entry.content_version)
        }) {
            if let (Some(id), Some(snapshot)) = (stash_id, previous_snapshot) {
                entry.page_number_stashes.insert(id, snapshot);
            }
            return Ok(PageNumbersOutcome {
                applied: true,
                padding: entry.padding_sheets(),
            });
        }
        // The other layer rebuilds from its current config, its subset taken
        // under the lock — the accepted cost of stacking a second layer.
        let watermark = self.existing_watermark(entry)?;
        let page_numbers = PageNumbersPlan::Compute {
            resources: self.page_numbers_resources(&config)?,
            padding: entry.padding_indices(),
        };

        let applied =
            self.verify_and_rebuild(entry, watermark, page_numbers, &mut on_progress, &operation)?;
        let padding = if applied {
            if let (Some(id), Some(snapshot)) = (stash_id, previous_snapshot) {
                entry.page_number_stashes.insert(id, snapshot);
            }
            entry.padding_sheets()
        } else {
            Vec::new()
        };

        Ok(PageNumbersOutcome { applied, padding })
    }

    #[cfg(test)]
    pub(super) fn apply_page_numbers(
        &self,
        document_id: u64,
        config: PageNumbersConfig,
    ) -> Result<bool, String> {
        self.apply_page_numbers_with_progress(document_id, config, None, |_, _| {})
            .map(|outcome| outcome.applied)
    }

    /// Removes only the page numbers this open session owns, rebuilding any
    /// watermark so it survives the change unaltered.
    pub fn remove_page_numbers_with_progress(
        &self,
        document_id: u64,
        stash_id: Option<u64>,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<PageNumbersOutcome, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(PageNumbersOutcome {
                applied: false,
                padding: Vec::new(),
            });
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        if !entry
            .owned_content
            .as_ref()
            .is_some_and(|state| state.page_numbers.is_some())
        {
            return Err("this session has no page numbers to remove".into());
        }
        let previous_snapshot = stash_id.map(|_| Self::snapshot_page_numbers(entry));
        let watermark = self.existing_watermark(entry)?;

        let applied = self.verify_and_rebuild(
            entry,
            watermark,
            PageNumbersPlan::None,
            &mut on_progress,
            &operation,
        )?;
        let padding = if applied {
            if let (Some(id), Some(snapshot)) = (stash_id, previous_snapshot) {
                entry.page_number_stashes.insert(id, snapshot);
            }
            entry.padding_sheets()
        } else {
            Vec::new()
        };

        Ok(PageNumbersOutcome { applied, padding })
    }

    #[cfg(test)]
    pub(super) fn remove_page_numbers(&self, document_id: u64) -> Result<bool, String> {
        self.remove_page_numbers_with_progress(document_id, None, |_, _| {})
            .map(|outcome| outcome.applied)
    }

    /// Restores the exact page-number stamps and padding labels stashed before
    /// history entry `stash_id`: unlike re-running `apply_page_numbers`, this
    /// never fails when the document shrank past an earlier range and never
    /// shifts stamps across prior structure edits.
    pub fn restore_page_numbers_with_progress(
        &self,
        document_id: u64,
        stash_id: u64,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<PageNumbersOutcome, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;

        if operation.is_cancelled() {
            return Ok(PageNumbersOutcome {
                applied: false,
                padding: Vec::new(),
            });
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;
        let (config, stamps, padding_numbers) = {
            let Some(snapshot) = entry.page_number_stashes.get(&stash_id) else {
                return Err("there is no stashed page-number state under this undo entry".into());
            };
            (
                snapshot.config.clone(),
                snapshot.stamps.clone(),
                snapshot.padding_numbers.clone(),
            )
        };
        let watermark = self.existing_watermark(entry)?;
        let page_numbers = match &config {
            Some(config) => PageNumbersPlan::Restore {
                resources: self.page_numbers_resources(config)?,
                stamps,
                padding_numbers,
            },
            None => PageNumbersPlan::None,
        };

        let applied =
            self.verify_and_rebuild(entry, watermark, page_numbers, &mut on_progress, &operation)?;
        let padding = if applied {
            entry.page_number_stashes.remove(&stash_id);
            entry.padding_sheets()
        } else {
            Vec::new()
        };

        Ok(PageNumbersOutcome { applied, padding })
    }

    /// The virtual padding blanks a Save As will insert, with any page numbers
    /// currently planned for them.
    #[cfg(test)]
    pub(super) fn padding_sheets(&self, document_id: u64) -> Result<Vec<PdfPaddingSheet>, String> {
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;

        Ok(entry.padding_sheets())
    }
}
