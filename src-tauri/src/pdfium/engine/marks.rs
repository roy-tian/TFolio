use super::*;

// Capped at ordinary render dimensions so one drag cannot allocate an
// unbounded bitmap or inflate the saved file without limit.
pub(super) const RECT_EFFECT_DPI: f32 = 150.0;

/// Where this session's marks begin among a page's annotations: PDFium appends,
/// so they are the last `tail`; fewer is a desync that would reach the rest.
pub(super) fn owned_tail_base(
    page_number: i32,
    annotation_count: usize,
    tail: usize,
) -> Result<usize, String> {
    annotation_count
        .checked_sub(tail)
        .ok_or_else(|| format!("page {page_number} no longer carries this session's marks"))
}

impl PdfiumEngine {
    /// Covers `quads` on `page_number` with one highlight annotation — one mark
    /// as far as the reader is concerned, so taking it back is one step.
    pub(in crate::pdfium) fn add_highlight(
        &self,
        document_id: u64,
        page_number: i32,
        quads: &[PagePointsRect],
        color: &str,
        opacity: f32,
    ) -> Result<u64, String> {
        if quads.is_empty() {
            return Err("a highlight needs at least one quad".into());
        }

        if quads.len() > MAX_HIGHLIGHT_QUADS {
            return Err(format!(
                "a highlight may cover at most {MAX_HIGHLIGHT_QUADS} runs of text"
            ));
        }

        let color = annotation_color(color, opacity)?;
        // Fully transparent draws nothing yet still records as a mark; the UI
        // fixes opacity well above zero, but the command takes any value.
        if color.alpha() == 0 {
            return Err("a highlight needs a visible colour".into());
        }

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let unrotated_height = unrotated_page_height(&page);
        let rects = quads
            .iter()
            .map(|quad| page_rect_to_pdfium(quad, unrotated_height))
            .collect::<Vec<_>>();
        // PDFium draws a markup annotation from its quad points, but readers
        // expect `/Rect` to enclose them, so it is set from the run as a whole.
        let bounds = union_rect(&rects).ok_or_else(|| "highlight has no area".to_string())?;

        // Attached the moment it is created, so a failure past here has to take
        // it back off rather than return and leave a mark nothing can remove.
        let mut annotation = page
            .annotations_mut()
            .create_highlight_annotation()
            .map_err(|error| format!("PDFium could not create a highlight: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(bounds)
                .map_err(|error| format!("PDFium rejected the highlight's bounds: {error}"))?;
            // `set_stroke_color` even though a highlight is a fill: the names
            // map onto `/C` and `/IC`, and a highlight draws from `/C`, not `/IC`.
            annotation
                .set_stroke_color(color)
                .map_err(|error| format!("PDFium rejected the highlight's colour: {error}"))?;

            for rect in &rects {
                annotation
                    .attachment_points_mut()
                    .create_attachment_point_at_end(quad_points_from_rect(rect))
                    .map_err(|error| format!("PDFium rejected a highlight quad: {error}"))?;
            }

            Ok(())
        })();

        if let Err(error) = described {
            let annotations = page.annotations_mut();
            let count = annotations.len();

            if count > 0 {
                if let Ok(orphan) = annotations.get(count - 1) {
                    let _ = annotations.delete_annotation(orphan);
                }
            }

            return Err(error);
        }

        Ok(entry.record_mark(page_id))
    }

    /// The pixels inside `bounds` replaced by a raster treatment on one Stamp
    /// annotation; the page content beneath is untouched and still extractable.
    pub(in crate::pdfium) fn add_rect_effect(
        &self,
        document_id: u64,
        page_number: i32,
        bounds: &PagePointsRect,
        effect: &RectEffect,
    ) -> Result<u64, String> {
        if ![bounds.left, bounds.top, bounds.width, bounds.height]
            .iter()
            .all(|value| within_page_range(*value))
        {
            return Err("a rectangle effect's coordinates are out of range".into());
        }
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err("a rectangle effect needs a positive width and height".into());
        }
        if !(MIN_RECT_EFFECT_STRENGTH..=MAX_RECT_EFFECT_STRENGTH).contains(&effect.strength) {
            return Err("a rectangle effect's strength is out of range".into());
        }

        // Rendered before the annotation exists, so the capture includes marks
        // but never itself; the lock yields for the pure-pixel work that follows.
        let (
            rendered,
            rotation,
            displayed_width,
            displayed_height,
            unrotated_width,
            unrotated_height,
            captured_page_id,
            captured_revision,
        ) = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;
            let page_id = entry.page_id(page_number)?;

            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let rotation = page_rotation_degrees(&page);
            let displayed_width = page.width().value;
            let displayed_height = page.height().value;

            if !displayed_width.is_finite()
                || !displayed_height.is_finite()
                || displayed_width <= 0.0
                || displayed_height <= 0.0
            {
                return Err("a rectangle effect needs a page with usable dimensions".into());
            }

            let (unrotated_width, unrotated_height) = if rotation == 90.0 || rotation == 270.0 {
                (displayed_height, displayed_width)
            } else {
                (displayed_width, displayed_height)
            };

            if bounds.left < 0.0
                || bounds.top < 0.0
                || bounds.left + bounds.width > unrotated_width
                || bounds.top + bounds.height > unrotated_height
            {
                return Err("a rectangle effect must stay inside its page".into());
            }

            let rendered = Self::render_page_sample(&page, RECT_EFFECT_DPI).map_err(|error| {
                format!("PDFium could not capture page {page_number} for an effect: {error}")
            })?;

            (
                rendered,
                rotation,
                displayed_width,
                displayed_height,
                unrotated_width,
                unrotated_height,
                page_id,
                entry.revisions.get(&page_id).copied().unwrap_or(0),
            )
        };

        let displayed = rect_in_display_space(bounds, unrotated_width, unrotated_height, rotation);
        let scale_x = rendered.width() as f32 / displayed_width;
        let scale_y = rendered.height() as f32 / displayed_height;
        let left = (displayed.left * scale_x).floor().max(0.0) as u32;
        let top = (displayed.top * scale_y).floor().max(0.0) as u32;
        let right = ((displayed.left + displayed.width) * scale_x)
            .ceil()
            .min(rendered.width() as f32) as u32;
        let bottom = ((displayed.top + displayed.height) * scale_y)
            .ceil()
            .min(rendered.height() as f32) as u32;

        if right <= left || bottom <= top {
            return Err("a rectangle effect is too small to capture any pixels".into());
        }

        let captured = rendered.crop_imm(left, top, right - left, bottom - top);
        let source_pixels_per_point = (scale_x + scale_y) / 2.0;
        let processed = match effect.kind {
            RectEffectKind::Mosaic => {
                let block = (effect.strength * source_pixels_per_point).round().max(1.0) as u32;
                let reduced_width = captured.width().div_ceil(block).max(1);
                let reduced_height = captured.height().div_ceil(block).max(1);
                let reduced = imageops::resize(
                    &captured,
                    reduced_width,
                    reduced_height,
                    imageops::FilterType::Nearest,
                );

                DynamicImage::ImageRgba8(imageops::resize(
                    &reduced,
                    captured.width(),
                    captured.height(),
                    imageops::FilterType::Nearest,
                ))
            }
            RectEffectKind::Blur => DynamicImage::ImageRgba8(imageops::blur(
                &captured,
                effect.strength * source_pixels_per_point,
            )),
        };

        // The render includes the page's intrinsic rotation; page objects live
        // before it, so un-rotate the crop and let PDFium rotate when it draws.
        let processed = match rotation as i32 {
            90 => processed.rotate270(),
            180 => processed.rotate180(),
            270 => processed.rotate90(),
            _ => processed,
        };
        let pixel_width = i32::try_from(processed.width())
            .map_err(|_| "a rectangle effect image is too wide".to_string())?;
        let pixel_height = i32::try_from(processed.height())
            .map_err(|_| "a rectangle effect image is too tall".to_string())?;
        let mut bgra = processed.into_rgba8().into_raw();

        // `set_image()` does this RGBA -> BGRA swap only after creating a
        // PDFium bitmap, so it is done here, unlocked, ahead of the commit.
        for pixel in bgra.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }

        let placeholder = DynamicImage::new_rgba8(1, 1);
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // Found by id: a page inserted at the captured number must never
        // receive another page's pixels; a structure change fails the revision.
        let page_index = entry
            .page_ids
            .iter()
            .position(|id| *id == captured_page_id)
            .ok_or_else(|| {
                "the page changed while its rectangle effect was being prepared".to_string()
            })?;

        if entry.revisions.get(&captured_page_id).copied().unwrap_or(0) != captured_revision {
            return Err("the page changed while its rectangle effect was being prepared".into());
        }

        let rect = page_rect_to_pdfium(bounds, unrotated_height);
        let mut image = PdfPageImageObject::new_with_size(
            &entry.document,
            &placeholder,
            PdfPoints::new(bounds.width),
            PdfPoints::new(bounds.height),
        )
        .map_err(|error| format!("PDFium could not create the rectangle effect image: {error}"))?;
        let bitmap = PdfBitmap::from_bytes(
            pixel_width,
            pixel_height,
            PdfBitmapFormat::BGRA,
            bgra.as_mut_slice(),
        )
        .map_err(|error| {
            format!("PDFium could not prepare the rectangle effect pixels: {error}")
        })?;
        image.set_bitmap(&bitmap).map_err(|error| {
            format!("PDFium could not apply the rectangle effect pixels: {error}")
        })?;
        drop(bitmap);
        image
            .translate(rect.left(), rect.bottom())
            .map_err(|error| {
                format!("PDFium could not place the rectangle effect image: {error}")
            })?;

        // Annotation creation attaches immediately. Anything after it can fail,
        // so the same rollback used by the vector rectangle is required here.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_index as i32)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a rectangle effect: {error}"))?;
        let described = (|| {
            annotation.set_bounds(rect).map_err(|error| {
                format!("PDFium rejected the rectangle effect's bounds: {error}")
            })?;
            annotation
                .objects_mut()
                .add_image_object(image)
                .map_err(|error| {
                    format!("PDFium rejected the rectangle effect's image: {error}")
                })?;
            Ok(())
        })();

        if let Err(error) = described {
            let annotations = page.annotations_mut();
            let count = annotations.len();

            if count > 0 {
                if let Ok(orphan) = annotations.get(count - 1) {
                    let _ = annotations.delete_annotation(orphan);
                }
            }

            return Err(error);
        }

        Ok(entry.record_mark(captured_page_id))
    }

    /// A rectangle as a Stamp with a hand-built path, not a Square: the same
    /// kind of mark the blur and mosaic leave, really rendered, not `/IC`/`/CA`.
    pub(in crate::pdfium) fn add_rect(
        &self,
        document_id: u64,
        page_number: i32,
        bounds: &PagePointsRect,
        style: &RectStyle,
    ) -> Result<u64, String> {
        // The WebView can call this with anything: an out-of-range coordinate is
        // refused, not clamped, before it can overflow a page edge to infinity.
        if ![bounds.left, bounds.top, bounds.width, bounds.height]
            .iter()
            .all(|value| within_page_range(*value))
        {
            return Err("a rectangle's coordinates are out of range".into());
        }

        // The slider's range (annotationStyles.ts) is the contract both sides
        // enforce: refused, not clamped — and never an invisible recorded edit.
        if !(MIN_RECT_OPACITY..=1.0).contains(&style.opacity) {
            return Err("a rectangle's style values are out of range".into());
        }

        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err("a rectangle needs a positive width and height".into());
        }

        let fill = annotation_color(&style.color, style.opacity)?;
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

        // Loaded only for its unrotated height, then dropped: the path below
        // borrows `&entry.document`, which a live page would hold borrowed.
        let unrotated_height = {
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            unrotated_page_height(&page)
        };
        let rect = page_rect_to_pdfium(bounds, unrotated_height);

        // A free object until added below, so a failure leaves nothing to take
        // off; traced on the bounds, so the fill lands where the preview drew.
        let mut path = PdfPagePathObject::new(
            &entry.document,
            rect.left(),
            rect.bottom(),
            None,
            None,
            Some(fill),
        )
        .map_err(|error| format!("PDFium could not start the rectangle: {error}"))?;

        for (x, y) in [
            (rect.right(), rect.bottom()),
            (rect.right(), rect.top()),
            (rect.left(), rect.top()),
        ] {
            path.line_to(x, y)
                .map_err(|error| format!("PDFium rejected a rectangle edge: {error}"))?;
        }

        path.close_path()
            .map_err(|error| format!("PDFium could not close the rectangle: {error}"))?;

        // Attached the moment it is created, so a failure past here has to take
        // it back off rather than leave a mark nothing can remove.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a rectangle: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(rect)
                .map_err(|error| format!("PDFium rejected the rectangle's bounds: {error}"))?;
            annotation
                .objects_mut()
                .add_path_object(path)
                .map_err(|error| format!("PDFium rejected the rectangle's path: {error}"))?;
            Ok(())
        })();

        if let Err(error) = described {
            let annotations = page.annotations_mut();
            let count = annotations.len();

            if count > 0 {
                if let Ok(orphan) = annotations.get(count - 1) {
                    let _ = annotations.delete_annotation(orphan);
                }
            }

            return Err(error);
        }

        Ok(entry.record_mark(page_id))
    }

    /// A stamp, not the FreeText the format has for this: PDFium 0.9.3 exposes
    /// no font size or face on one. No wrapping — a note breaks at returns only.
    pub(in crate::pdfium) fn add_text_note(
        &self,
        document_id: u64,
        page_number: i32,
        origin: &PagePoint,
        text: &str,
        style: &TextNoteStyle,
    ) -> Result<u64, String> {
        if !within_page_range(origin.left) || !within_page_range(origin.top) {
            return Err("a note's coordinates are out of range".into());
        }

        // As with a rectangle's style, refused rather than clamped: clamping
        // would draw a note in a size the reader never picked.
        if !(MIN_TEXT_NOTE_FONT_SIZE..=MAX_TEXT_NOTE_FONT_SIZE).contains(&style.font_size)
            || !(MIN_TEXT_NOTE_OPACITY..=1.0).contains(&style.opacity)
        {
            return Err("a note's style values are out of range".into());
        }

        let color = annotation_color(&style.color, style.opacity)?;

        // Invisible is a failure, not a note: a fully transparent one would be
        // stored, saved, and recorded as an edit while drawing nothing.
        if color.alpha() == 0 {
            return Err("a note needs a visible colour".into());
        }

        // Blank is not a note either. Checked before the length ceiling so a
        // whitespace-only note fails as empty rather than as too long.
        if text.trim().is_empty() {
            return Err("a note needs some text".into());
        }

        if text.chars().count() > MAX_TEXT_NOTE_CHARS {
            return Err("a note is too long".into());
        }

        // `\r\n` and `\r` both count as one break, so a note pasted from another
        // platform does not gain a blank line between every line.
        let lines: Vec<&str> = text
            .split('\n')
            .map(|line| line.trim_end_matches('\r'))
            .collect();

        if lines.len() > MAX_TEXT_NOTE_LINES {
            return Err("a note has too many lines".into());
        }

        // Subset before the lock: cutting a face is the slow part and needs no
        // document, so renders should not queue behind it.
        let embedded = if needs_embedded_font(text) {
            Some(self.embedded_face_subset(text)?)
        } else {
            None
        };

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_id = entry.page_id(page_number)?;

        let unrotated_height = {
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            unrotated_page_height(&page)
        };

        // Text the standard 14 cover costs no embedded bytes at all, which is
        // the common case for a Latin note; anything else carries its subset.
        let font = match &embedded {
            // Loaded afresh each time; a loaded font stays in the document, and
            // the token cannot be cached — `pdfium-render` 0.9.3 marks it not `Send`.
            Some(bytes) => entry
                .document
                .fonts_mut()
                .load_true_type_from_bytes(bytes, true)
                .map_err(|error| format!("PDFium rejected the note's font: {error}"))?,
            None => entry.document.fonts_mut().helvetica(),
        };

        let ascent = entry
            .document
            .fonts()
            .get(font)
            .ok_or_else(|| "PDFium lost the note's font".to_string())?
            .ascent(PdfPoints::new(style.font_size))
            .map_err(|error| format!("PDFium could not measure the note's font: {error}"))?
            .value;

        // Laid out before the annotation exists: PDFium fits a stamp's appearance
        // to its `/Rect`, so late bounds squash the text. Free objects until added.
        let mut laid_out = Vec::new();
        let mut text_bounds: Option<PdfRect> = None;

        for (index, line) in lines.iter().enumerate() {
            // A blank line draws nothing but still advances the next one, which
            // is how an empty line between paragraphs survives.
            if line.is_empty() {
                continue;
            }

            let mut object = PdfPageTextObject::new(
                &entry.document,
                line,
                font,
                PdfPoints::new(style.font_size),
            )
            .map_err(|error| format!("PDFium rejected a line of the note: {error}"))?;

            object
                .set_fill_color(color)
                .map_err(|error| format!("PDFium rejected the note's colour: {error}"))?;

            // PDFium draws from the baseline; a reader clicks the top where the
            // text should start — hence the ascent, from the font, not guessed.
            let baseline =
                origin.top + ascent + index as f32 * style.font_size * TEXT_NOTE_LINE_HEIGHT;

            object
                .translate(
                    PdfPoints::new(origin.left),
                    PdfPoints::new(unrotated_height - baseline),
                )
                .map_err(|error| format!("PDFium could not place the note: {error}"))?;

            let placed = object
                .bounds()
                .map_err(|error| format!("PDFium could not measure the note: {error}"))?;

            let line_bounds =
                PdfRect::new(placed.bottom(), placed.left(), placed.top(), placed.right());

            text_bounds = Some(match text_bounds {
                None => line_bounds,
                Some(so_far) => union_rect(&[so_far, line_bounds])
                    .expect("a union of two rectangles is never empty"),
            });
            laid_out.push(object);
        }

        // Every line was blank, so there is nothing to show — the same
        // invisible-but-recorded edit the colour check above refuses.
        let text_bounds = text_bounds.ok_or_else(|| "a note needs some text".to_string())?;
        // A hair wider than the ink: the appearance is fitted to this box, and
        // a glyph ending on its edge would lose its outermost antialiased pixel.
        let bounds = PdfRect::new_from_values(
            text_bounds.bottom().value - TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.left().value - TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.top().value + TEXT_NOTE_BOUNDS_MARGIN,
            text_bounds.right().value + TEXT_NOTE_BOUNDS_MARGIN,
        );

        // Attached the moment it is created, so a failure past here has to take
        // it back off rather than leave a mark nothing can remove.
        let mut page = entry
            .document
            .pages_mut()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let mut annotation = page
            .annotations_mut()
            .create_stamp_annotation()
            .map_err(|error| format!("PDFium could not create a note: {error}"))?;
        let described = (|| {
            annotation
                .set_bounds(bounds)
                .map_err(|error| format!("PDFium rejected the note's bounds: {error}"))?;

            for object in laid_out {
                annotation
                    .objects_mut()
                    .add_text_object(object)
                    .map_err(|error| format!("PDFium rejected a line of the note: {error}"))?;
            }

            Ok(())
        })();

        if let Err(error) = described {
            let annotations = page.annotations_mut();
            let count = annotations.len();

            if count > 0 {
                if let Ok(orphan) = annotations.get(count - 1) {
                    let _ = annotations.delete_annotation(orphan);
                }
            }

            return Err(error);
        }

        Ok(entry.record_mark(page_id))
    }

    /// An id is itself the proof the annotation behind it is this session's to
    /// remove; re-checked here, since the caller is a browser and can lie.
    pub(in crate::pdfium) fn delete_marks(
        &self,
        document_id: u64,
        mark_ids: &[u64],
    ) -> Result<Vec<i32>, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // One id twice would delete twice at one position, the second time
        // taking whichever annotation slid into it.
        let mut seen = HashSet::with_capacity(mark_ids.len());

        if !mark_ids.iter().all(|mark_id| seen.insert(*mark_id)) {
            return Err("a mark cannot be removed twice in one step".into());
        }

        // Every id is placed before any annotation goes, so a list naming one
        // mark this session never made removes nothing at all.
        let located = mark_ids
            .iter()
            .map(|mark_id| entry.locate_mark(*mark_id))
            .collect::<Result<Vec<_>, _>>()?;

        // Nothing named, nothing removed — and in particular nothing to collect
        // afterwards, so the next write keeps the cheap route.
        if located.is_empty() {
            return Ok(Vec::new());
        }

        // Deleted from the back of each page's tail forward, so every position
        // still names its own annotation when its turn comes.
        let mut order = (0..located.len()).collect::<Vec<_>>();

        order.sort_by_key(|index| {
            let (page_id, _, position) = located[*index];

            (page_id, std::cmp::Reverse(position))
        });

        // Every page is verified before the first annotation goes: a halfway
        // removal would leave history and document shapes no undo can reach.
        for (page_id, page_number, _) in &located {
            let tail = entry.marks.get(page_id).map_or(0, Vec::len);
            let page = entry
                .document
                .pages()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            owned_tail_base(*page_number, page.annotations().len(), tail)?;
        }

        // Set before the first removal: a step failing partway has still left
        // orphans, and the next write collects either way.
        entry.needs_compaction = true;

        for index in order {
            let (page_id, page_number, position) = located[index];
            let tail = entry.marks.get(&page_id).map_or(0, Vec::len);
            let mut page = entry
                .document
                .pages_mut()
                .get(page_number - 1)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
            let annotations = page.annotations_mut();
            let base = owned_tail_base(page_number, annotations.len(), tail)?;
            let annotation = annotations
                .get(base + position)
                .map_err(|error| format!("PDFium could not load the annotation: {error}"))?;

            annotations
                .delete_annotation(annotation)
                .map_err(|error| format!("PDFium could not remove the annotation: {error}"))?;

            if let Some(marks) = entry.marks.get_mut(&page_id) {
                marks.remove(position);
            }

            entry.bump_page_revision(page_id);
        }

        Ok(located
            .iter()
            .map(|(_, page_number, _)| *page_number)
            .collect())
    }

    /// Topmost first — the one the reader sees, PDFium drawing in order — and
    /// only the session's own tail, which is all the eraser may find.
    pub(in crate::pdfium) fn mark_at_point(
        &self,
        document_id: u64,
        page_number: i32,
        point: &PagePoint,
    ) -> Result<Option<u64>, String> {
        if !within_page_range(point.left) || !within_page_range(point.top) {
            return Err("the point is out of range".into());
        }

        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;
        let page_id = entry.page_id(page_number)?;
        let marks = match entry.marks.get(&page_id) {
            Some(marks) if !marks.is_empty() => marks,
            _ => return Ok(None),
        };

        let page = entry
            .document
            .pages()
            .get(page_number - 1)
            .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;
        let annotations = page.annotations();
        let base = owned_tail_base(page_number, annotations.len(), marks.len())?;
        // The point arrives in unrotated page points from the top left, as every
        // annotation payload does; PDFium counts from the bottom left.
        let x = point.left;
        let y = unrotated_page_height(&page) - point.top;

        for (position, mark_id) in marks.iter().enumerate().rev() {
            let annotation = annotations
                .get(base + position)
                .map_err(|error| format!("PDFium could not load the annotation: {error}"))?;

            if annotation_covers(&annotation, x, y) {
                return Ok(Some(*mark_id));
            }
        }

        Ok(None)
    }
}
