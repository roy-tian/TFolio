//! The digital signatures a file opens with. Only their structure is checked,
//! never the CMS: "intact" means each signature's byte range still frames its
//! own `/Contents` in the file on disk, which every PDFium rewrite undoes.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::raw::{c_int, c_void},
    ptr,
};

use super::page_import::{detached_pages, Headed};
use super::signature_flatten::flatten_signatures;
use super::*;
use super::{
    io::{fingerprint, write_file_atomically, Fingerprint},
    same_file,
};
use crate::pdfium::SignatureDecision;

/// Far past any CMS a signer embeds; a larger `/Contents` is not checked.
const MAX_SIGNATURE_BYTES: usize = 4 * 1024 * 1024;

/// An unchanged signed document's copy refused because its file was replaced
/// since the open. Matched as `SIGNED_ORIGINAL_CHANGED` in `src/lib/pdf.ts`.
pub(super) const SIGNED_ORIGINAL_CHANGED_ERROR: &str = "tfolio:signed-original-changed";

/// A write aimed at a file whose intact signatures it would break. Matched as
/// `EXPORT_SIGNED` in `src/lib/pdf.ts`.
pub(super) const EXPORT_SIGNED_ERROR: &str = "tfolio:export-signed";

/// A change or a new file that would break intact signatures, asked for before
/// the reader said what becomes of them. The frontend asks first, so this only
/// guards the command and nothing there matches it.
pub(super) const SIGNATURES_UNDECIDED_ERROR: &str = "tfolio:signatures-undecided";

/// A file read for a document, as it stood when read.
#[derive(Clone, Debug)]
pub(super) struct OpenedFile {
    pub(super) path: PathBuf,
    pub(super) fingerprint: Fingerprint,
}

struct SignedRange {
    byte_range: Vec<c_int>,
    contents: Vec<u8>,
}

/// What PDFium says of a document's signatures, read under the documents lock
/// so that the file it opened from can be checked against it off the lock.
pub(super) struct SignatureScan(Vec<Option<SignedRange>>);

impl SignatureScan {
    pub(super) fn of(document: &PdfDocument<'_>) -> Self {
        Self(signed_ranges(document))
    }

    /// Reads `file`, which may be slow storage, so never under a lock.
    pub(super) fn intact_in(&self, file: &OpenedFile) -> bool {
        !self.0.is_empty() && frames_intact(file, &self.0)
    }

    pub(super) fn count(&self) -> usize {
        self.0.len()
    }

    pub(super) fn summary(&self, intact: bool) -> PdfSignatures {
        PdfSignatures {
            count: self.0.len(),
            intact,
            decision: None,
            flattened: false,
        }
    }
}

impl OpenDocument {
    pub(super) fn signatures(&self) -> PdfSignatures {
        PdfSignatures {
            count: self.signature_count,
            intact: self.bound_to_signed_original(),
            decision: self.signature_decision,
            flattened: self.signatures_flattened,
        }
    }

    /// An edit breaks intact signatures, so it waits for the reader's word:
    /// kept, or flattened, which happens in place before the first edit.
    pub(super) fn ensure_editable(&self) -> Result<(), String> {
        if self.signed_original.is_none()
            || self.signature_decision == Some(SignatureDecision::Keep)
            || self.signatures_flattened
        {
            Ok(())
        } else {
            Err(SIGNATURES_UNDECIDED_ERROR.into())
        }
    }

    /// Whether a new file made of this document's pages draws its signatures
    /// into them; refused while the reader has not said.
    pub(super) fn output_flattens(&self) -> Result<bool, String> {
        if self.signed_original.is_none() || self.signatures_flattened {
            return Ok(false);
        }

        match self.signature_decision {
            Some(decision) => Ok(decision == SignatureDecision::Flatten),
            None => Err(SIGNATURES_UNDECIDED_ERROR.into()),
        }
    }
}

/// Marks the pages showing a signature field's widget, which their thumbnails
/// mark, and returns their indices; none for a document without signatures.
pub(super) fn mark_signature_pages(
    scan: &SignatureScan,
    document: &PdfDocument<'_>,
    pages: &mut [PdfPageInfo],
) -> Vec<usize> {
    if scan.count() == 0 {
        return Vec::new();
    }

    let signed: Vec<usize> = document
        .pages()
        .iter()
        .enumerate()
        .filter(|(_, page)| {
            page.annotations().iter().any(|annotation| {
                matches!(annotation.as_form_field(), Some(PdfFormField::Signature(_)))
            })
        })
        .map(|(index, _)| index)
        .collect();

    for &index in &signed {
        if let Some(page) = pages.get_mut(index) {
            page.signed = true;
        }
    }

    signed
}

/// `document` with its signatures drawn into its pages, as a new document;
/// `None` where there were none to draw. Under the documents lock.
pub(super) fn flattened_copy(
    pdfium: &'static Pdfium,
    document: &PdfDocument<'_>,
) -> Result<Option<PdfDocument<'static>>, String> {
    let bytes = document
        .save_to_bytes()
        .map_err(|error| format!("PDFium could not rewrite the document: {error}"))?;

    flatten_signatures(&bytes)?
        .map(|flattened| {
            pdfium
                .load_pdf_from_byte_vec(flattened, None)
                .map_err(|error| format!("PDFium could not open the flattened document: {error}"))
        })
        .transpose()
}

/// Pages `indices` (0-based, ascending) of `source` alone in a new document,
/// their signatures drawn in: a copy of just these pages, not of the whole
/// document, goes through the rewrite. Under the documents lock.
pub(super) fn flattened_pages(
    pdfium: &'static Pdfium,
    source: &PdfDocument<'_>,
    indices: &[usize],
) -> Result<PdfDocument<'static>, String> {
    let pages = detached_pages(pdfium, source, indices, Headed::Away)?;

    Ok(flattened_copy(pdfium, &pages)?.unwrap_or(pages))
}

/// Whether page `index` carries a widget, which a signature always has: a
/// page without one is copied as it is, sparing it the rewrite.
pub(super) fn has_widgets(source: &PdfDocument<'_>, index: PdfPageIndex) -> Result<bool, String> {
    let page = source
        .pages()
        .get(index)
        .map_err(|error| format!("PDFium could not load page {}: {error}", index + 1))?;

    Ok(page
        .annotations()
        .iter()
        .any(|annotation| annotation.annotation_type() == PdfPageAnnotationType::Widget))
}

/// `bytes` with its signatures drawn into its pages: PDFium's fresh output, or
/// lopdf's rewrite of it.
pub(super) fn flattened_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    Ok(flatten_signatures(&bytes)?.unwrap_or(bytes))
}

impl PdfiumEngine {
    /// Records what becomes of the document's intact signatures. An answer
    /// may change only until it has acted in place, by an edit or a flatten,
    /// so a flatten that failed can still give way to keeping the fields.
    pub fn decide_signatures(
        &self,
        document_id: u64,
        decision: SignatureDecision,
    ) -> Result<PdfSignatures, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        if !entry.signatures_flattened && entry.content_version == 0 {
            entry.signature_decision = Some(decision);
        }

        Ok(entry.signatures())
    }

    /// Draws the document's signatures into its pages in place, before its
    /// first change: nothing of this session's own is there to keep track of.
    pub fn flatten_signatures(&self, document_id: u64) -> Result<PdfStructureUpdate, String> {
        let _operation = self.begin_operation(OperationTarget::Document(document_id));
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        if entry.signatures_flattened {
            return Ok(structure_update(entry));
        }

        if entry.signature_decision == Some(SignatureDecision::Keep) {
            return Err("the signatures were chosen to be kept".into());
        }

        if entry.content_version != 0 {
            return Err("signatures are flattened only before the document's first change".into());
        }

        if let Some(flattened) = flattened_copy(self.pdfium, &entry.document)? {
            entry.document = flattened;
            entry.invalidate_all_page_revisions();
        }

        entry.signature_decision = Some(SignatureDecision::Flatten);
        entry.signatures_flattened = true;
        entry.signed_page_ids.clear();

        Ok(structure_update(entry))
    }

    /// Whether a write to `path` would break intact signatures: the file an
    /// open document opened from, wherever it is bound now, or a file read
    /// to be added. Called with the documents lock held, which precedes the
    /// sources'.
    pub(super) fn is_signed_file(
        &self,
        documents: &HashMap<u64, OpenDocument>,
        path: &Path,
    ) -> bool {
        documents.values().any(|document| {
            document
                .signed_original
                .as_ref()
                .is_some_and(|original| same_file(&original.path, path))
                || document
                    .signed_added
                    .iter()
                    .any(|added| same_file(added, path))
        }) || self.lock_sources().is_signed_source(path)
    }
}

/// One entry per signature PDFium counts; `None` where it would not say.
fn signed_ranges(document: &PdfDocument<'_>) -> Vec<Option<SignedRange>> {
    let bindings = document.bindings();
    let handle = bindings.get_handle_from_document(document);
    // SAFETY: the handle lives for this borrow and the engine serializes PDFium
    // calls. pdfium-render's own count casts PDFium's -1 to 65535.
    let count = unsafe { bindings.FPDF_GetSignatureCount(handle) };

    (0..count.max(0))
        .map(|index| {
            // SAFETY: as above; the handle lives as long as the document does,
            // and each buffer is sized by the length PDFium reported for it.
            unsafe {
                let signature = bindings.FPDF_GetSignatureObject(handle, index);

                if signature.is_null() {
                    return None;
                }

                let range_len =
                    bindings.FPDFSignatureObj_GetByteRange(signature, ptr::null_mut(), 0);
                let mut byte_range = vec![0; range_len as usize];

                if range_len > 0 {
                    bindings.FPDFSignatureObj_GetByteRange(
                        signature,
                        byte_range.as_mut_ptr(),
                        range_len,
                    );
                }

                let contents_len =
                    bindings.FPDFSignatureObj_GetContents(signature, ptr::null_mut(), 0);

                let size = contents_len as usize;

                if size > MAX_SIGNATURE_BYTES {
                    return None;
                }

                let mut contents = vec![0u8; size];

                if contents_len > 0 {
                    bindings.FPDFSignatureObj_GetContents(
                        signature,
                        contents.as_mut_ptr() as *mut c_void,
                        contents_len,
                    );
                }

                Some(SignedRange {
                    byte_range,
                    contents,
                })
            }
        })
        .collect()
}

fn frames_intact(file: &OpenedFile, ranges: &[Option<SignedRange>]) -> bool {
    let Ok(mut handle) = File::open(&file.path) else {
        return false;
    };
    let Ok(metadata) = handle.metadata() else {
        return false;
    };

    // The bytes PDFium parsed are gone; the file stands in only while unchanged.
    if Fingerprint::of(&metadata) != file.fingerprint {
        return false;
    }

    ranges.iter().all(|range| {
        range
            .as_ref()
            .is_some_and(|range| frames(&mut handle, metadata.len(), range))
    })
}

/// Whether `[0, a)` and `[b, b + c)` leave out exactly the `/Contents` string,
/// its delimiters with it or without.
fn frames(file: &mut File, len: u64, range: &SignedRange) -> bool {
    let &[start, a, b, c] = range.byte_range.as_slice() else {
        return false;
    };
    let (Ok(start), Ok(a), Ok(b), Ok(c)) = (
        u64::try_from(start),
        u64::try_from(a),
        u64::try_from(b),
        u64::try_from(c),
    ) else {
        return false;
    };

    // An empty gap frames no `/Contents`: nothing was signed into it.
    if start != 0 || a >= b || b.checked_add(c).is_none_or(|end| end > len) {
        return false;
    }

    let gap = b - a;

    if gap > (MAX_SIGNATURE_BYTES * 2 + 2) as u64 {
        return false;
    }

    let mut framed = vec![0u8; gap as usize];

    if file.seek(SeekFrom::Start(a)).is_err() || file.read_exact(&mut framed).is_err() {
        return false;
    }

    // As PDF reads a hex string: whitespace (NUL included) is not part of it,
    // and an odd last digit is followed by a 0.
    framed.retain(|byte| !byte.is_ascii_whitespace() && *byte != 0);

    let hex = framed
        .strip_prefix(b"<")
        .and_then(|rest| rest.strip_suffix(b">"))
        .unwrap_or(&framed);
    let (pairs, rest) = hex.as_chunks::<2>();
    let last = rest.first().map(|&high| [high, b'0']);

    pairs.len() + usize::from(last.is_some()) == range.contents.len()
        && pairs
            .iter()
            .copied()
            .chain(last)
            .zip(&range.contents)
            .all(|(pair, byte)| hex_byte(pair) == Some(*byte))
}

fn hex_byte([high, low]: [u8; 2]) -> Option<u8> {
    let digit = |value: u8| (value as char).to_digit(16);

    Some((digit(high)? * 16 + digit(low)?) as u8)
}

/// `original`'s bytes at `path`: an unchanged document's copy that keeps every
/// signature, where PDFium's rewrite would keep none. Refused, leaving nothing
/// written, if the file changed since the open — before the copy or during it.
pub(super) fn copy_original(original: &OpenedFile, path: &Path) -> Result<(), String> {
    let unchanged = |file: &File| {
        file.metadata()
            .is_ok_and(|metadata| Fingerprint::of(&metadata) == original.fingerprint)
    };
    let mut source = File::open(&original.path)
        .map_err(|error| format!("could not read {}: {error}", original.path.display()))?;

    if !unchanged(&source) {
        return Err(SIGNED_ORIGINAL_CHANGED_ERROR.into());
    }

    write_file_atomically(path, |file| {
        std::io::copy(&mut source, file)
            .map_err(|error| format!("could not copy the signed file: {error}"))?;

        // The handle reads the replaced file's old bytes after a rename over
        // it, but not a write into it: either way the copy is not the original.
        if !unchanged(&source)
            || fingerprint(&original.path).is_none_or(|now| now != original.fingerprint)
        {
            return Err(SIGNED_ORIGINAL_CHANGED_ERROR.into());
        }

        Ok(true)
    })
    .map(|_| ())
}
