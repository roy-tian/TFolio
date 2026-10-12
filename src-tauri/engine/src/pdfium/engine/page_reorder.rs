use pdfium_render::prelude::*;
use std::os::raw::c_ulong;

/// Moving pages in place keeps bookmark destinations on their pages;
/// importing pages into a new document would orphan them. The caller holds the
/// engine's PDFium lock and supplies a validated permutation.
///
/// pdfium-render binds FPDF_MovePages without a safe wrapper, and its page
/// index cache models only contiguous shifts, not permutations. Bypassing it
/// is sound only while no `PdfPage` of this document is alive, leaving that
/// cache nothing to go stale on; engine calls drop their pages before returning.
pub(super) fn move_pages(
    bindings: &dyn PdfiumLibraryBindings,
    document: &mut PdfDocument<'static>,
    indices: &[PdfPageIndex],
) -> Result<(), String> {
    // SAFETY: the handle stays live for this exclusive borrow, indices is a
    // valid buffer of its own length, and the engine serializes PDFium calls.
    let moved = unsafe {
        bindings.FPDF_MovePages(
            bindings.get_handle_from_document(document),
            indices.as_ptr(),
            indices.len() as c_ulong,
            0,
        )
    };

    if bindings.is_true(moved) {
        Ok(())
    } else {
        Err("PDFium could not reorder the pages".into())
    }
}
