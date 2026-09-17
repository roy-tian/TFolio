use super::*;

// A guided merge holds every source in memory at once under the same MiB
// ceiling as an open, so the count is what bounds the whole run.
pub(super) const MAX_MERGE_FILES: usize = 64;

// An image is read whole before it is decoded, and a photograph is nothing
// like a document in size, so its ceiling sits well under the PDF one.
pub(super) const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

// An A4 page scanned at 600dpi is about 35 megapixels: generous room above
// real input while refusing a header claiming a bitmap no machine could hold.
pub(super) const MAX_IMAGE_PIXELS: u64 = 80_000_000;

/// Writes `path` via a temporary file beside it, renamed into place only once
/// every byte is on disk; `false` abandons, leaving nothing half-written.
pub(super) fn write_file_atomically(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<bool, String>,
) -> Result<bool, String> {
    // A fresh export has nothing to canonicalize; the given path is it.
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = path.as_path();
    // A bare name has `""` for a parent, which would put the temporary file in
    // the start directory — losing the atomic rename, which needs one filesystem.
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => return Err(format!("{} is not a usable destination", path.display())),
    };
    // Random, and created only if absent: a guessable name could sit as a
    // symlink, and a launch-reset counter would hit a crash's leftover forever.
    let suffix =
        getrandom::u64().map_err(|error| format!("could not name a temporary file: {error}"))?;
    let temporary = directory.join(format!(
        ".{}.{suffix:016x}.tfolio-save",
        bounded_file_name(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("document.pdf")
        ),
    ));

    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("could not write beside {}: {error}", path.display()))?;

    // Through the handle `create_new` proved ours, never by name again: in that
    // gap the path could be swapped for a symlink, and save_to_file opens by path.
    let written = write(&mut file).and_then(|keep| {
        if !keep {
            return Ok(false);
        }

        // The rename only orders the replacement; a crash between an unsynced
        // rename and the writeback would leave a hollow file behind the name.
        file.sync_all()
            .map_err(|error| format!("could not flush the document: {error}"))
            .map(|()| true)
    });

    drop(file);

    // The temporary was born with default permissions; the file it replaces may
    // be tighter (a 0600 document must not come back 0644). Best effort.
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&temporary, metadata.permissions());
    }

    let renamed = written.and_then(|keep| {
        if !keep {
            return Ok(false);
        }

        fs::rename(&temporary, path)
            .map_err(|error| format!("could not write to {}: {error}", path.display()))
            .map(|()| true)
    });

    if !matches!(renamed, Ok(true)) {
        // Hidden, so one left behind is one the reader would never find.
        let _ = fs::remove_file(&temporary);
    } else if let Ok(handle) = fs::File::open(directory) {
        // The rename itself lives in the directory; flush that too, best
        // effort, so the replacement survives a crash.
        let _ = handle.sync_all();
    }

    renamed
}

/// At most 200 bytes, cut on a character boundary: the temporary adds a dot,
/// sixteen hex digits and `.tfolio-save`, all within the 255-byte NAME_MAX.
pub(super) fn bounded_file_name(name: &str) -> &str {
    const BUDGET: usize = 200;

    if name.len() <= BUDGET {
        return name;
    }

    let mut end = BUDGET;

    while !name.is_char_boundary(end) {
        end -= 1;
    }

    &name[..end]
}

/// Whether two paths name one file. A fresh destination resolves through its
/// parent; the unresolvable compare literally, erring towards "different".
pub(super) fn same_file(left: &Path, right: &Path) -> bool {
    fn resolved(path: &Path) -> PathBuf {
        if let Ok(canonical) = path.canonicalize() {
            return canonical;
        }

        match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => match parent.canonicalize() {
                Ok(parent) => parent.join(name),
                Err(_) => path.to_path_buf(),
            },
            _ => path.to_path_buf(),
        }
    }

    resolved(left) == resolved(right)
}

/// A PDF read into memory under the app's ceiling, sized from metadata first so
/// an oversized file is refused before it is read — and checked again after.
pub(super) fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;

    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }

    if metadata.len() > MAX_PDF_BYTES as u64 {
        return Err(size_limit_error());
    }

    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;

    if bytes.is_empty() {
        return Err("PDF file is empty".into());
    }

    if bytes.len() > MAX_PDF_BYTES {
        return Err(size_limit_error());
    }

    Ok(bytes)
}

pub(crate) fn is_merge_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MERGE_IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

/// Decodes `path` under both ceilings. The format comes from the bytes, not the
/// extension: a mislabelled file is a decode error, not a hazard.
pub(super) fn read_image(path: &Path) -> Result<DynamicImage, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;

    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }

    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(image_limit_error());
    }

    let mut limits = image::Limits::default();

    limits.max_alloc = Some(MAX_IMAGE_PIXELS * 4);

    let mut reader = image::ImageReader::open(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?
        .with_guessed_format()
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;

    reader.limits(limits);

    let unusable =
        |error: image::ImageError| format!("{} is not a usable image: {error}", path.display());
    let mut decoder = reader.into_decoder().map_err(unusable)?;
    let (width, height) = decoder.dimensions();

    // Off the header, before a pixel is allocated: `max_alloc` is documented as
    // non-strict, so the size a file claims must refuse the bitmap itself.
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
        || decoder.total_bytes() > MAX_IMAGE_PIXELS * 4
    {
        return Err(image_limit_error());
    }

    // Cameras record orientation in metadata, not pixels; without this a
    // portrait photograph arrives landscape and lands sideways on the sheet.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(unusable)?;

    image.apply_orientation(orientation);

    Ok(image)
}

/// The image laid on a turned A4 sheet, scaled to fill. An image has no page
/// size of its own, so it is always fitted, whatever the merge's A4 option says.
pub(super) fn image_page_document<'a>(
    pdfium: &'a Pdfium,
    path: &Path,
) -> Result<PdfDocument<'a>, String> {
    let image = read_image(path)?;
    let pixel_width = image.width() as f32;
    let pixel_height = image.height() as f32;

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
    let mut object = PdfPageImageObject::new_with_size(
        &document,
        &image,
        PdfPoints::new(width),
        PdfPoints::new(height),
    )
    .map_err(|error| format!("PDFium could not place {}: {error}", path.display()))?;

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

pub(super) fn load_merge_source<'a>(
    pdfium: &'a Pdfium,
    path: &Path,
) -> Result<PdfDocument<'a>, String> {
    if is_merge_image(path) {
        return image_page_document(pdfium, path);
    }

    // The error wording matches `open`'s, so an encrypted file is refused the
    // same way whichever door it comes through.
    pdfium
        .load_pdf_from_byte_vec(read_pdf_bytes(path)?, None)
        .map_err(|error| format!("PDFium could not open the document: {error}"))
}

/// Page `index` onto a fresh A4 sheet as a form XObject: PDFium cannot resize
/// an imported page, and a form leaves annotations behind, hence opt-in only.
pub(super) fn append_page_fitted_to_a4<'a>(
    merged: &mut PdfDocument<'a>,
    source: &PdfDocument<'a>,
    index: PdfPageIndex,
    path: &Path,
) -> Result<(), String> {
    let failed = |what: &str, error: PdfiumError| {
        format!(
            "PDFium could not {what} page {} of {}: {error}",
            index + 1,
            path.display()
        )
    };
    // Through `objects_mut`, the accessor keeping the document's lifetime: the
    // form must outlive the page borrow to reach the sheet built below.
    let mut page = source
        .pages()
        .get(index)
        .map_err(|error| failed("load", error))?;
    // The displayed size, `/Rotate` applied — the space the form arrives in too,
    // since PDFium builds it through the page's display matrix.
    let placement = a4_placement(page.width().value, page.height().value);
    let mut form = page
        .objects_mut()
        .copy_into_x_object_form_object(merged)
        .map_err(|error| failed("copy", error))?;

    // One matrix, not a scale then a translate: PDFium composes each call onto
    // what the object carries, and these offsets are measured on the sheet.
    form.transform(
        placement.scale as PdfMatrixValue,
        0.0,
        0.0,
        placement.scale as PdfMatrixValue,
        placement.left as PdfMatrixValue,
        placement.bottom as PdfMatrixValue,
    )
    .map_err(|error| failed("place", error))?;

    let mut sheet = merged
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::Custom(
            PdfPoints::new(placement.sheet_width),
            PdfPoints::new(placement.sheet_height),
        ))
        .map_err(|error| format!("PDFium could not create the A4 sheet: {error}"))?;

    sheet
        .objects_mut()
        .add_object(form)
        .map_err(|error| failed("add", error))?;
    sheet
        .regenerate_content()
        .map_err(|error| failed("finish the sheet for", error))?;

    Ok(())
}

pub(super) fn image_limit_error() -> String {
    format!(
        "image file exceeds the {} MiB limit",
        MAX_IMAGE_BYTES / 1024 / 1024
    )
}

pub(super) fn merge_file_limit_error() -> String {
    format!("a merge takes at most {MAX_MERGE_FILES} files")
}

/// The file's name without extension; a path ending in no name falls back to
/// the whole path, so a bookmark is never blank.
pub(super) fn bookmark_title(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

pub(super) fn merge_bookmark_nodes(
    mode: MergeBookmarks,
    title: String,
    start: usize,
    outline: Vec<PdfOutlineItem>,
) -> Vec<OutlineNode> {
    match mode {
        MergeBookmarks::None => Vec::new(),
        MergeBookmarks::PerFile => vec![OutlineNode {
            title,
            page: start,
            children: Vec::new(),
        }],
        MergeBookmarks::KeepExisting => remapped_outline(outline, start),
        MergeBookmarks::PerFileWithExisting => vec![OutlineNode {
            title,
            page: start,
            children: remapped_outline(outline, start),
        }],
    }
}

/// A source's outline moved onto the pages it now occupies; an unreadable
/// destination points at the file's first page, never outside the file.
pub(super) fn remapped_outline(items: Vec<PdfOutlineItem>, start: usize) -> Vec<OutlineNode> {
    items
        .into_iter()
        .map(|item| OutlineNode {
            title: item.title,
            page: start
                + item
                    .page_number
                    .map_or(0, |number| number.max(1) as usize - 1),
            children: remapped_outline(item.items, start),
        })
        .collect()
}

impl PdfiumEngine {
    /// Every Word document among `paths` as a PDF, or the refusal saying why
    /// not; the stop flag is the caller's, each pipeline under its own operation.
    pub(super) fn resolve_word_documents(
        &self,
        paths: &[PathBuf],
        enabled: bool,
        cancelled: &dyn Fn() -> bool,
        on_converted: &mut dyn FnMut(),
    ) -> Vec<crate::convert::Entry> {
        if !enabled
            || !paths
                .iter()
                .any(|path| crate::convert::is_word_document(path))
        {
            return paths
                .iter()
                .map(|_| crate::convert::Entry::NotWord)
                .collect();
        }

        match self.word.resolve(paths, cancelled, on_converted) {
            Ok(entries) => entries,
            Err(_) => paths
                .iter()
                .map(|path| {
                    if crate::convert::is_word_document(path) {
                        crate::convert::Entry::Failed(crate::convert::ConvertError::Failed(
                            "stopped by the reader".into(),
                        ))
                    } else {
                        crate::convert::Entry::NotWord
                    }
                })
                .collect(),
        }
    }

    /// The guided merge's backend half. The result has no source path, so it can
    /// only ever be exported to a copy, never written back over a source.
    pub(in crate::pdfium) fn merge_files_with_progress(
        &self,
        paths: Vec<PathBuf>,
        smart_padding: bool,
        normalize_a4: bool,
        bookmarks: MergeBookmarks,
        word_conversion: bool,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<Option<PdfDocumentInfo>, String> {
        if paths.len() < 2 {
            return Err("a merge needs at least two files".into());
        }

        if paths.len() > MAX_MERGE_FILES {
            return Err(merge_file_limit_error());
        }

        // Stoppable like an owned-layer rebuild, whose loop holds the one lock
        // for the whole pile; nothing needs rollback — the store is joined last.
        let operation = self.begin_operation(OperationTarget::Merge);

        // One unit per source, plus the conversions this run will really do
        // (a cache hit adds none), then serialization, outline, and opening.
        let conversions = if word_conversion {
            self.word.pending_count(&paths)
        } else {
            0
        };
        let total = paths.len() + 3 + conversions;

        on_progress(0, total);

        // Conversions run before the lock: an office suite's startup is seconds
        // another process spends, and no render should wait behind it.
        let cancelled = || operation.is_cancelled();
        let mut converted = 0usize;
        let word = self.resolve_word_documents(&paths, word_conversion, &cancelled, &mut || {
            converted += 1;
            on_progress(converted, total);
        });

        // The estimate promised pending conversions; only a difference from
        // what this run really did is worth reporting.
        let mut total = total;
        let mut completed = converted;

        if converted != conversions {
            total = paths.len() + 3 + converted;
            on_progress(completed.min(total), total);
        }

        if operation.is_cancelled() {
            return Ok(None);
        }

        for (path, entry) in paths.iter().zip(&word) {
            if let crate::convert::Entry::Failed(error) = entry {
                return Err(format!(
                    "{} could not be converted: {error}",
                    path.display()
                ));
            }
        }

        let (bytes, nodes) = {
            // Building is PDFium work, so under the store's lock — given back
            // before `open_with_source` takes it again, as `create_blank` does.
            let _documents = self.lock_documents()?;
            let mut merged = self
                .pdfium
                .create_new_pdf()
                .map_err(|error| format!("PDFium could not create a document: {error}"))?;
            let mut nodes = Vec::new();

            for (path, word) in paths.iter().zip(&word) {
                // Between files, which is this loop's page: a source is copied
                // whole or not at all.
                if operation.is_cancelled() {
                    return Ok(None);
                }

                // A Word source is read from the PDF its conversion left; its
                // name — errors, bookmark title — stays the reader's own file's.
                let read_from = match word {
                    crate::convert::Entry::Converted(pdf) => pdf.as_path(),
                    _ => path,
                };

                // Each source is opened only to be copied from and dropped at the
                // end of this loop; none of them ever enters the document store.
                let source = load_merge_source(self.pdfium, read_from)?;

                if source.pages().is_empty() {
                    return Err(format!("{} has no pages", path.display()));
                }

                if smart_padding && merged.pages().len() % 2 == 1 {
                    // Sized like the file it precedes, so the blank reads as
                    // that file's leading sheet — or its coming A4 sheet.
                    let (width, height) = {
                        let first = source.pages().get(0).map_err(|error| {
                            format!(
                                "PDFium could not load a page of {}: {error}",
                                path.display()
                            )
                        })?;

                        if normalize_a4 {
                            let placement = a4_placement(first.width().value, first.height().value);

                            (placement.sheet_width, placement.sheet_height)
                        } else {
                            unrotated_page_size(&first)
                        }
                    };
                    let page = merged
                        .pages_mut()
                        .create_page_at_end(PdfPagePaperSize::Custom(
                            PdfPoints::new(width),
                            PdfPoints::new(height),
                        ))
                        .map_err(|error| {
                            format!("PDFium could not create the blank page: {error}")
                        })?;

                    drop(page);
                }

                // Taken after the pad, so a bookmark points at the file's own
                // first page rather than the blank in front of it.
                let start = merged.pages().len().max(0) as usize;
                // Read before the append, which imports pages alone: PDFium
                // leaves the outline behind, hence the hand-written one after.
                let outline = collect_bookmark_siblings(source.bookmarks().root());

                if normalize_a4 {
                    // Page by page rather than in one call: each sheet is sized
                    // and its content placed on its own terms.
                    for index in 0..source.pages().len() {
                        // A long file's pages are this loop's unit under the one
                        // lock, so the stop is read here too, not only between files.
                        if operation.is_cancelled() {
                            return Ok(None);
                        }

                        append_page_fitted_to_a4(&mut merged, &source, index, path)?;
                    }
                } else {
                    merged.pages_mut().append(&source).map_err(|error| {
                        format!("PDFium could not merge {}: {error}", path.display())
                    })?;
                }

                nodes.extend(merge_bookmark_nodes(
                    bookmarks,
                    bookmark_title(path),
                    start,
                    outline,
                ));
                completed += 1;
                on_progress(completed, total);
            }

            // The three steps below each walk the whole merge, so each is
            // worth not starting once the reader has left.
            if operation.is_cancelled() {
                return Ok(None);
            }

            let bytes = merged
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not build the merged document: {error}"))?;
            completed += 1;
            on_progress(completed, total);

            (bytes, nodes)
        };

        if operation.is_cancelled() {
            return Ok(None);
        }

        // Outline writing is byte work, not PDFium work, so the lock is given
        // back — a long merge must not park every render behind it.
        let bytes = outline::write_outline(bytes, &nodes)?;
        completed += 1;
        on_progress(completed, total);

        // The sources passed the ceiling each on their own; their sum is what
        // this checks, before opening, so an oversized merge is not parked.
        if bytes.len() > MAX_PDF_BYTES {
            return Err(size_limit_error());
        }
        // The last chance to leave with nothing in the store: what opens here
        // is a document the reader would then have to close.
        if operation.is_cancelled() {
            return Ok(None);
        }

        let document = self.open_with_source(bytes, None)?;
        completed += 1;
        on_progress(completed, total);

        Ok(Some(document))
    }

    #[cfg(test)]
    pub(super) fn merge_files(
        &self,
        paths: Vec<PathBuf>,
        smart_padding: bool,
        bookmarks: MergeBookmarks,
    ) -> Result<PdfDocumentInfo, String> {
        self.merge_files_with_progress(paths, smart_padding, false, bookmarks, false, |_, _| {})?
            .ok_or_else(|| "the merge was stopped".to_string())
    }

    #[cfg(test)]
    pub(super) fn merge_files_onto_a4(
        &self,
        paths: Vec<PathBuf>,
        smart_padding: bool,
    ) -> Result<PdfDocumentInfo, String> {
        self.merge_files_with_progress(
            paths,
            smart_padding,
            true,
            MergeBookmarks::None,
            false,
            |_, _| {},
        )?
        .ok_or_else(|| "the merge was stopped".to_string())
    }

    pub(in crate::pdfium) fn save(&self, document_id: u64) -> Result<(), String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // Layer ownership ends at close, so a saved-over file keeps a mark this
        // app can no longer lift; checked here, the WebView can call the command.
        if entry
            .owned_content
            .as_ref()
            .is_some_and(OwnedContentState::has_active_layer)
        {
            return Err(
                "a document with a watermark or page numbers may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

        // Another file's pages carry the same restriction, for the same reason:
        // again enforced here, not trusted to the disabled key.
        if !entry.merged_page_ids.is_empty() {
            return Err(
                "a document holding another PDF's pages may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

        let path = entry.source_path.clone().ok_or_else(|| {
            "this document was opened from bytes, so there is no file to save over".to_string()
        })?;

        self.write_document(entry, &path, &operation)
    }

    /// Writes to `path`, adopting it as the source of a byte-opened document —
    /// a true save-as. The flag tells the frontend the file matches the history.
    pub(in crate::pdfium) fn export_to(
        &self,
        document_id: u64,
        path: &Path,
    ) -> Result<ExportOutcome, String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        // The same refusal `save` makes, at the other exit. Unlike the flag
        // below, this resolves aliases: a missed twin would destroy the original.
        if (entry
            .owned_content
            .as_ref()
            .is_some_and(OwnedContentState::has_active_layer)
            || !entry.merged_page_ids.is_empty())
            && entry
                .source_path
                .as_deref()
                .is_some_and(|source| same_file(source, path))
        {
            return Err(
                "this document may only be exported as a copy, not written back over its own file"
                    .into(),
            );
        }

        self.write_document(entry, path, &operation)?;

        // Compared verbatim, not canonicalized: mistaking a symlinked twin for
        // a stranger only dirties the history — the safe direction.
        let saved_to_source = match &entry.source_path {
            Some(source) => source.as_path() == path,
            None => {
                entry.source_path = Some(path.to_path_buf());
                true
            }
        };

        Ok(ExportOutcome {
            path: path.to_string_lossy().into_owned(),
            saved_to_source,
        })
    }

    /// The bare write `save` and `export_to` share; test-only since the dialogs
    /// moved into the commands.
    #[cfg(test)]
    pub(in crate::pdfium) fn save_to(&self, document_id: u64, path: &Path) -> Result<(), String> {
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        self.write_document(entry, path, &operation)
    }

    /// Reloads off the document's saved bytes — the only place PDFium collects
    /// unreferenced objects — after a deletion only, for the extra memory copy.
    pub(super) fn collect_orphans(&self, entry: &mut OpenDocument) -> Result<(), String> {
        if !entry.needs_compaction {
            return Ok(());
        }

        let bytes = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;

        let reloaded = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reload the document: {error}"))?;

        if let Some(state) = &entry.owned_content {
            Self::verify_owned_tail(&reloaded, &entry.page_ids, state).map_err(|error| {
                format!("PDFium did not preserve the owned content during compaction: {error}")
            })?;
        }

        entry.document = reloaded;
        entry.needs_compaction = false;

        Ok(())
    }

    /// The one write path under every save and export, so their files come out
    /// identical — collected of orphans, and landed whole.
    pub(super) fn write_document(
        &self,
        entry: &mut OpenDocument,
        path: &Path,
        operation: &OperationGuard<'_>,
    ) -> Result<(), String> {
        if entry
            .owned_content
            .as_ref()
            .and_then(|state| state.watermark.as_ref())
            .is_some_and(|config| config.rasterize)
        {
            let bytes = self
                .rasterized_bytes(&entry.document, operation, &FLATTEN_LEVELS, |_, _| {})?
                .ok_or_else(|| "image PDF export was cancelled".to_string())?;
            return write_file_atomically(path, |file| {
                file.write_all(&bytes)
                    .map_err(|error| format!("could not write the image PDF: {error}"))?;
                Ok(true)
            })
            .map(|_| ());
        }

        self.collect_orphans(entry)?;

        write_file_atomically(path, |file| {
            entry
                .document
                .save_to_writer(file)
                .map_err(|error| format!("PDFium could not write the document: {error}"))
                .map(|()| true)
        })
        .map(|_| ())
    }
}
