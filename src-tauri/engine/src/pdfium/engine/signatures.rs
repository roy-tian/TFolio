//! The digital signatures a file opens with. Only their structure is checked,
//! never the CMS: "intact" means each signature's byte range still frames its
//! own `/Contents` in the file on disk, which every PDFium rewrite undoes.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::raw::{c_int, c_void},
    ptr,
};

use super::io::{fingerprint, same_file, write_file_atomically, Fingerprint};
use super::*;

/// Far past any CMS a signer embeds; a larger `/Contents` is not checked.
const MAX_SIGNATURE_BYTES: usize = 4 * 1024 * 1024;

/// An unchanged signed document's copy refused because its file was replaced
/// since the open. Matched as `SIGNED_ORIGINAL_CHANGED` in `src/lib/pdf.ts`.
pub(super) const SIGNED_ORIGINAL_CHANGED_ERROR: &str = "tfolio:signed-original-changed";

/// A write aimed at a file whose intact signatures it would break. Matched as
/// `EXPORT_SIGNED` in `src/lib/pdf.ts`.
pub(super) const EXPORT_SIGNED_ERROR: &str = "tfolio:export-signed";

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

    pub(super) fn summary(&self, intact: bool) -> PdfSignatures {
        PdfSignatures {
            count: self.0.len(),
            intact,
        }
    }
}

impl PdfiumEngine {
    /// Whether a write to `path` would break intact signatures: the file an
    /// open document opened from, wherever it is bound now, or an organize
    /// source. Called with the documents lock held, which precedes organize's.
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
        }) || self.lock_organize().is_signed_source(path)
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
