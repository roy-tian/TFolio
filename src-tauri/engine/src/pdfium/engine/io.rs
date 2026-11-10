use std::time::SystemTime;

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

/// A file written beside its destination and put in place by `commit` —
/// every byte on disk first — or, dropped uncommitted, removed again: a
/// destination is never left half-written. Split so a caller can let the
/// documents lock go between the write PDFium does and the disk's own wait.
pub(super) struct StagedFile {
    path: PathBuf,
    directory: PathBuf,
    temporary: PathBuf,
    file: Option<fs::File>,
}

impl StagedFile {
    pub(super) fn beside(path: &Path) -> Result<Self, String> {
        // A fresh export has nothing to canonicalize; the given path is it.
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        // A bare name has `""` for a parent, which would put the temporary file in
        // the start directory — losing the atomic rename, which needs one filesystem.
        let directory = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => return Err(format!("{} is not a usable destination", path.display())),
        };
        // Random, and created only if absent: a guessable name could sit as a
        // symlink, and a launch-reset counter would hit a crash's leftover forever.
        let suffix = getrandom::u64()
            .map_err(|error| format!("could not name a temporary file: {error}"))?;
        let temporary = directory.join(format!(
            ".{}.{suffix:016x}.tfolio-save",
            bounded_file_name(
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("document.pdf")
            ),
        ));

        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                write_error(
                    &error,
                    format!("could not write beside {}: {error}", path.display()),
                )
            })?;

        Ok(Self {
            path,
            directory,
            temporary,
            file: Some(file),
        })
    }

    /// Through the handle `create_new` proved ours, never by name again: in
    /// that gap the path could be swapped for a symlink.
    pub(super) fn file(&mut self) -> &mut fs::File {
        self.file
            .as_mut()
            .expect("a staged file keeps its handle until it is committed")
    }

    /// Staged already written: bytes another step made of PDFium's.
    pub(super) fn holding(path: &Path, bytes: &[u8]) -> Result<Self, String> {
        let mut staged = Self::beside(path)?;

        staged
            .file()
            .write_all(bytes)
            .map_err(|error| format!("could not write the document: {error}"))?;

        Ok(staged)
    }

    pub(super) fn commit(mut self) -> Result<(), String> {
        let file = self
            .file
            .take()
            .expect("a staged file keeps its handle until it is committed");

        // The rename only orders the replacement; a crash between an unsynced
        // rename and the writeback would leave a hollow file behind the name.
        file.sync_all()
            .map_err(|error| format!("could not flush the document: {error}"))?;
        drop(file);

        // The temporary was born with default permissions; the file it replaces may
        // be tighter (a 0600 document must not come back 0644). Best effort.
        if let Ok(metadata) = fs::metadata(&self.path) {
            let _ = fs::set_permissions(&self.temporary, metadata.permissions());
        }

        fs::rename(&self.temporary, &self.path).map_err(|error| {
            write_error(
                &error,
                format!("could not write to {}: {error}", self.path.display()),
            )
        })?;
        // In place: nothing for the drop to take back.
        self.temporary = PathBuf::new();

        // The rename itself lives in the directory; flush that too, best
        // effort, so the replacement survives a crash.
        if let Ok(handle) = fs::File::open(&self.directory) {
            let _ = handle.sync_all();
        }

        Ok(())
    }
}

/// How an export lands its file: PDFium's write staged at once, or PDFium's
/// bytes still to be given their outline, off the documents lock.
enum Staging {
    Staged(StagedFile),
    Outlined(Vec<u8>, Vec<OutlineNode>),
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        // Hidden, so one left behind is one the reader would never find.
        if !self.temporary.as_os_str().is_empty() {
            self.file = None;
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

/// Writes `path` via a temporary file beside it, renamed into place only once
/// every byte is on disk; `false` abandons, leaving nothing half-written.
pub(super) fn write_file_atomically(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<bool, String>,
) -> Result<bool, String> {
    let mut staged = StagedFile::beside(path)?;

    if !write(staged.file())? {
        return Ok(false);
    }

    staged.commit().map(|()| true)
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

/// Whether `path` is the file of an open document other than `except`, aliases
/// included. The destination is read once: the scan runs under the documents lock.
pub(super) fn is_open_document_file(
    documents: &HashMap<u64, OpenDocument>,
    path: &Path,
    except: Option<u64>,
) -> bool {
    let target = FileKey::of(path);

    documents.iter().any(|(id, document)| {
        Some(*id) != except
            && document
                .source_path
                .as_deref()
                .is_some_and(|source| FileKey::of(source).names_same_file(&target))
    })
}

/// A wire value the frontend matches verbatim (`EXPORT_TARGET_OPEN` in
/// `src/lib/pdf.ts`), not a message.
pub(super) const EXPORT_TARGET_OPEN_ERROR: &str = "tfolio:export-target-open";

/// A copy-only document asked to write over its own file — the one a
/// sourceless document adopted on its first export included. Matched as
/// `EXPORT_COPY_ONLY` in `src/lib/pdf.ts`.
pub(super) const EXPORT_COPY_ONLY_ERROR: &str = "tfolio:export-copy-only";

/// A destination the OS will not let this process write: a read-only file,
/// folder or volume — or, on Windows, a file another program holds open,
/// which fails the rename the same way. Matched as `EXPORT_DENIED` in
/// `src/lib/pdf.ts`.
pub(super) const EXPORT_DENIED_ERROR: &str = "tfolio:export-denied";

/// A refusal the reader can act on travels as a code the frontend words;
/// anything else keeps its message for the log.
fn write_error(error: &std::io::Error, message: String) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
            EXPORT_DENIED_ERROR.into()
        }
        _ => message,
    }
}

/// A file as it stood when read: what tells a later look that it changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

impl Fingerprint {
    pub(super) fn of(metadata: &fs::Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

pub(super) fn fingerprint(path: &Path) -> Option<Fingerprint> {
    fs::metadata(path)
        .ok()
        .map(|metadata| Fingerprint::of(&metadata))
}

/// A PDF read into memory under the app's ceiling, sized from metadata first so
/// an oversized file is refused before it is read — and checked again after.
pub(super) fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    read_pdf_file(path).map(|(bytes, _)| bytes)
}

/// `read_pdf_bytes` with the fingerprint of the metadata it sized the read by:
/// taken before the read, so a file changed during it never matches it again.
pub(super) fn read_pdf_file(path: &Path) -> Result<(Vec<u8>, Fingerprint), String> {
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

    Ok((bytes, Fingerprint::of(&metadata)))
}

pub fn is_merge_image(path: &Path) -> bool {
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
    image: &DynamicImage,
    path: &Path,
) -> Result<PdfDocument<'a>, String> {
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
        image,
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

/// A merge source as read off the disk: a PDF's bytes or an image's pixels,
/// read and decoded before PDFium, and the lock its work needs, is involved.
pub(super) enum SourceFile {
    Pdf(Vec<u8>),
    Image(DynamicImage),
}

pub(super) fn read_merge_source(path: &Path) -> Result<SourceFile, String> {
    if is_merge_image(path) {
        read_image(path).map(SourceFile::Image)
    } else {
        read_pdf_bytes(path).map(SourceFile::Pdf)
    }
}

/// PDFium's half of loading a source, for the caller to run under the lock.
pub(super) fn load_merge_source<'a>(
    pdfium: &'a Pdfium,
    source: SourceFile,
    path: &Path,
) -> Result<PdfDocument<'a>, String> {
    match source {
        SourceFile::Image(image) => image_page_document(pdfium, &image, path),
        // The error wording matches `open`'s, so an encrypted file is refused
        // the same way whichever door it comes through.
        SourceFile::Pdf(bytes) => pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not open the document: {error}")),
    }
}

/// A merge's document between imports, which each take the lock for their
/// own PDFium work. Closed under the lock however the run ends — early
/// returns included — since closing is PDFium work too. Callers declare their
/// lock guards after it, so a guard is always given back before this takes one.
pub(super) struct MergeDraft<'a> {
    engine: &'a PdfiumEngine,
    document: Option<PdfDocument<'static>>,
}

impl<'a> MergeDraft<'a> {
    pub(super) fn new(engine: &'a PdfiumEngine) -> Result<Self, String> {
        let _documents = engine.lock_documents()?;
        let document = engine
            .pdfium
            .create_new_pdf()
            .map_err(|error| format!("PDFium could not create a document: {error}"))?;

        Ok(Self {
            engine,
            document: Some(document),
        })
    }

    /// A document made under the lock the caller holds, closed as a draft's.
    pub(super) fn holding(engine: &'a PdfiumEngine, document: PdfDocument<'static>) -> Self {
        Self {
            engine,
            document: Some(document),
        }
    }

    /// Only while the caller holds the lock.
    pub(super) fn document(&mut self) -> &mut PdfDocument<'static> {
        self.document
            .as_mut()
            .expect("a merge draft keeps its document until it is closed")
    }

    /// Also only while the caller holds the lock.
    pub(super) fn close(&mut self) {
        self.document = None;
    }
}

impl Drop for MergeDraft<'_> {
    fn drop(&mut self) {
        if let Some(document) = self.document.take() {
            let _documents = self.engine.lock_documents();
            drop(document);
        }
    }
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
    format!("a document takes at most {MAX_MERGE_FILES} files at once")
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

    pub fn save(&self, document_id: u64) -> Result<(), String> {
        let _operation = self.begin_operation(OperationTarget::Document(document_id));
        let _commits = self.lock_commits()?;
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

        // Copies of such pages carry the same restriction, for the same
        // reason: again enforced here, not trusted to the disabled key.
        if !entry.merged_page_ids.is_empty() {
            return Err(
                "a document holding copies of pages with a watermark or page numbers may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

        if entry.bound_to_signed_original() {
            return Err(
                "a document opened with intact digital signatures may only be exported as a copy, not saved over its own file"
                    .into(),
            );
        }

        // The reader's choice, kept here so the WebView cannot skip it: the
        // file stays as it was, and the combined pages go to a new one.
        if entry.combined() {
            return Err(
                "a document with pages added from other files may only be saved as a new file, not over its own"
                    .into(),
            );
        }

        let path = entry.source_path.clone().ok_or_else(|| {
            "this document was opened from bytes, so there is no file to save over".to_string()
        })?;
        let (version, loaded_len) = (entry.content_version, entry.loaded_len);
        let staged = self.stage_document(entry, &path)?;

        drop(documents);
        staged.commit().inspect_err(|_| {
            self.after_failed_commit(document_id, |entry| {
                if entry.content_version == version {
                    entry.loaded_len = loaded_len;
                }
            });
        })?;
        self.record_written(document_id, &path);

        Ok(())
    }

    /// Whether something other than this document has written its file since
    /// the document last read or wrote it — for a converted one, its image or
    /// Word file since the conversion. A file gone, or none to compare, has
    /// nothing newer to offer.
    pub fn document_file_changed(&self, document_id: u64) -> Result<bool, String> {
        // A commit in flight would read as someone else's write until it has
        // recorded its own; saves take this lock first, so this waits it out.
        let _commits = self.lock_commits()?;
        let (path, expected) = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;

            match (&entry.source_path, &entry.converted_from) {
                (Some(path), _) => (path.clone(), entry.source_fingerprint),
                (None, Some(source)) => (source.path.clone(), Some(source.fingerprint)),
                (None, None) => return Ok(false),
            }
        };

        // Off the documents lock: the file may sit on slow storage.
        Ok(expected
            .zip(fingerprint(&path))
            .is_some_and(|(expected, current)| expected != current))
    }

    /// The file a commit just landed is this document's own write, which an
    /// open of it again must not take for someone else's. Taken while the
    /// writer still holds the commits lock, so no check sees the file first.
    fn record_written(&self, document_id: u64, path: &Path) {
        let written = fingerprint(path);

        if let Ok(mut documents) = self.lock_documents() {
            if let Ok(entry) = open_entry_mut(&mut documents, document_id) {
                entry.source_fingerprint = written;
                entry.converted_from = None;
            }
        }
    }

    /// The folder a save-as dialog should open in for this document: its own
    /// file's, when it has one. `None` — no file, or the store busy with an
    /// edit — tells the caller to fall back elsewhere.
    pub fn document_source_dir(&self, document_id: u64) -> Option<PathBuf> {
        let documents = self.try_lock_documents()?;
        open_entry(&documents, document_id)
            .ok()?
            .source_path
            .as_deref()
            .and_then(|source| source.parent())
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_path_buf())
    }

    /// The refusals a new file written to `path` would meet, asked ahead of
    /// work that could otherwise only end in one.
    pub fn check_new_file_destination(&self, path: &Path) -> Result<(), String> {
        let documents = self.lock_documents()?;

        if is_open_document_file(&documents, path, None) {
            return Err(EXPORT_TARGET_OPEN_ERROR.into());
        }

        if self.is_signed_file(&documents, path) {
            return Err(signatures::EXPORT_SIGNED_ERROR.into());
        }

        Ok(())
    }

    /// Writes to `path` and binds the document to it — a true save-as, after
    /// which `save` writes there and the old file stays as it was. A copy-only
    /// document with a file stays bound to it: `save` refuses that file, so
    /// binding the copy would refuse the next write to the copy as well.
    pub fn export_to(&self, document_id: u64, path: &Path) -> Result<ExportOutcome, String> {
        let _operation = self.begin_operation(OperationTarget::Document(document_id));
        let _commits = self.lock_commits()?;
        let mut documents = self.lock_documents()?;

        // Two documents bound to one file would each save over the other's
        // edits, and a copy landing there would leave the holder's history lying.
        if is_open_document_file(&documents, path, Some(document_id)) {
            return Err(EXPORT_TARGET_OPEN_ERROR.into());
        }

        // Its own signed file included, wherever the document is bound now.
        if self.is_signed_file(&documents, path) {
            return Err(signatures::EXPORT_SIGNED_ERROR.into());
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        let copy_only = entry
            .owned_content
            .as_ref()
            .is_some_and(OwnedContentState::has_active_layer)
            || !entry.merged_page_ids.is_empty();

        // The same refusal `save` makes, at the other exit. This resolves
        // aliases: a missed twin would destroy the original. Added files'
        // pages go to a new file too, though the document then follows them.
        if (copy_only || entry.combined())
            && entry
                .source_path
                .as_deref()
                .is_some_and(|source| same_file(source, path))
        {
            return Err(EXPORT_COPY_ONLY_ERROR.into());
        }

        // Unchanged, the copy is the file itself: PDFium's rewrite would break
        // every signature. Not rebound, since that copy is a signed original too.
        if entry.content_version == 0 && entry.bound_to_signed_original() {
            if let Some(original) = entry.signed_original.clone() {
                let signatures = entry.signatures();

                drop(documents);
                signatures::copy_original(&original, path)?;

                return Ok(ExportOutcome {
                    path: path.to_string_lossy().into_owned(),
                    saved_to_source: false,
                    signatures,
                });
            }
        }

        let (version, loaded_len) = (entry.content_version, entry.loaded_len);
        // Several files write their bookmarks afresh, one each, which only
        // lopdf can: it rereads PDFium's bytes off the lock, then stages them.
        // So do an added file's pages left alone: PDFium's outline is still
        // the document's own, aimed at pages that may all be gone.
        let staging = match entry.save_as_layout() {
            None => Staging::Staged(self.stage_document(entry, path)?),
            Some((padding, nodes)) => {
                let bytes = self.document_bytes(entry)?;

                Staging::Outlined(self.padded(bytes, entry, &padding)?, nodes)
            }
        };

        // A copy-only document reaching here wrote somewhere other than its file.
        // Bound before the commit, under the lock that checked the destination;
        // a commit that fails puts the old binding back.
        let saved_to_source = !(copy_only && entry.source_path.is_some());
        let previous_source = entry.source_path.clone();
        if saved_to_source {
            entry.source_path = Some(path.to_path_buf());
        }
        let signatures = entry.signatures();

        drop(documents);

        let written = match staging {
            Staging::Staged(staged) => Ok(staged),
            Staging::Outlined(bytes, nodes) => outline::write_outline(bytes, &nodes)
                .and_then(|bytes| StagedFile::holding(path, &bytes)),
        }
        .and_then(StagedFile::commit);

        if let Err(error) = written {
            self.after_failed_commit(document_id, |entry| {
                if saved_to_source {
                    entry.source_path = previous_source;
                }
                if entry.content_version == version {
                    entry.loaded_len = loaded_len;
                }
            });

            return Err(error);
        }

        if saved_to_source {
            self.record_written(document_id, path);
        }

        Ok(ExportOutcome {
            path: path.to_string_lossy().into_owned(),
            saved_to_source,
            signatures,
        })
    }

    /// The bare write `save` and `export_to` share; test-only since the dialogs
    /// moved into the commands.
    #[cfg(test)]
    pub fn save_to(&self, document_id: u64, path: &Path) -> Result<(), String> {
        let _operation = self.begin_operation(OperationTarget::Document(document_id));
        let _commits = self.lock_commits()?;
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let staged = self.stage_document(entry, path)?;

        drop(documents);
        staged.commit()
    }

    fn lock_commits(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.commits
            .lock()
            .map_err(|_| "PDFium document store is unavailable".to_string())
    }

    /// A commit that never landed left the file as it was, so `undo` puts back
    /// what staging retired — the compress baseline only while no edit since
    /// has retired it anyway.
    fn after_failed_commit(&self, document_id: u64, undo: impl FnOnce(&mut OpenDocument)) {
        if let Ok(mut documents) = self.lock_documents() {
            if let Ok(entry) = open_entry_mut(&mut documents, document_id) {
                undo(entry);
            }
        }
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
            // Part of a save, which has no Stop: checked in one pass.
            Self::verify_owned_tail(&reloaded, &entry.page_ids, state, None, &mut |_, _| {})
                .map_err(|error| {
                    format!("PDFium did not preserve the owned content during compaction: {error}")
                })?;
        }

        entry.document = reloaded;
        entry.needs_compaction = false;

        Ok(())
    }

    /// What a Save As of a document other files were added to writes, as
    /// bytes: its blank pages and its bookmarks a file at a time. `None` for a
    /// document of its own pages alone, whose bytes are PDFium's as they stand.
    /// Left as the reader's document is: no orphans collected, nothing bound.
    pub(super) fn combined_bytes(&self, entry: &OpenDocument) -> Option<Result<Vec<u8>, String>> {
        let (padding, nodes) = entry.save_as_layout()?;

        Some(
            entry
                .document
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not write the document: {error}"))
                .and_then(|bytes| self.padded(bytes, entry, &padding))
                .and_then(|bytes| outline::write_outline(bytes, &nodes)),
        )
    }

    /// `bytes` with a blank page after each page `padding` names, sized as
    /// that page shows: a copy's, so the reader's document keeps none.
    fn padded(
        &self,
        bytes: Vec<u8>,
        entry: &OpenDocument,
        padding: &[usize],
    ) -> Result<Vec<u8>, String> {
        let sheets: Vec<_> = padding
            .iter()
            .map(|after| {
                let shown = entry
                    .page_ids
                    .get(*after)
                    .and_then(|page_id| entry.page_geometry.get(page_id))
                    .copied()
                    .unwrap_or(UNMEASURED_PAGE);

                (*after, shown.width, shown.height)
            })
            .collect();

        self.with_blank_pages(bytes, &sheets)
    }

    /// `bytes` with a blank page `width` by `height` after each page index
    /// `sheets` names, in ascending order. Under the lock.
    pub(super) fn with_blank_pages(
        &self,
        bytes: Vec<u8>,
        sheets: &[(usize, f32, f32)],
    ) -> Result<Vec<u8>, String> {
        if sheets.is_empty() {
            return Ok(bytes);
        }

        let mut copy = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not reread the document: {error}"))?;

        // From the end, so each index still names the page it was taken for.
        for (after, width, height) in sheets.iter().rev() {
            copy.pages_mut()
                .create_page_at_index(
                    PdfPagePaperSize::Custom(PdfPoints::new(*width), PdfPoints::new(*height)),
                    *after as i32 + 1,
                )
                .map_err(|error| format!("PDFium could not add a blank page: {error}"))?;
        }

        copy.save_to_bytes()
            .map_err(|error| format!("PDFium could not write the document: {error}"))
    }

    /// `stage_document`'s bytes, for a caller that rewrites them before they land.
    fn document_bytes(&self, entry: &mut OpenDocument) -> Result<Vec<u8>, String> {
        self.written(entry, |document| document.save_to_bytes())
    }

    /// A save's one step: collected of orphans first, and the file it reads
    /// from no longer the bytes first opened once PDFium has rewritten them.
    fn written<T>(
        &self,
        entry: &mut OpenDocument,
        write: impl FnOnce(&PdfDocument<'static>) -> Result<T, PdfiumError>,
    ) -> Result<T, String> {
        self.collect_orphans(entry)?;

        let written = write(&entry.document)
            .map_err(|error| format!("PDFium could not write the document: {error}"))?;
        entry.loaded_len = None;

        Ok(written)
    }

    /// The one write path under every save and export, so their files come out
    /// identical — collected of orphans, and landed whole. Staged only: the
    /// caller commits once the documents lock is let go, so the fsync is no
    /// render's wait.
    pub(super) fn stage_document(
        &self,
        entry: &mut OpenDocument,
        path: &Path,
    ) -> Result<StagedFile, String> {
        let mut staged = StagedFile::beside(path)?;

        self.written(entry, |document| document.save_to_writer(staged.file()))?;

        Ok(staged)
    }
}
