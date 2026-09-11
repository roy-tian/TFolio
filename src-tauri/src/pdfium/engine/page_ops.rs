use super::io::read_pdf_bytes;
use super::owned_content::OwnedTailState;
use super::*;

/// A deleted page's copy and its session state, held so an undo can put both
/// back exactly — self-contained, in a document of its own, released with it.
pub(super) struct PageStash {
    pub(super) document: PdfDocument<'static>,
    /// One record per deleted page, ascending by original position — the order
    /// their copies sit in `document`, and the order a restore reinserts them.
    pub(super) pages: Vec<StashedPage>,
}

pub(super) struct StashedPage {
    /// The page's 1-based position at the moment it was deleted. LIFO undo
    /// guarantees the document is back in that shape when a restore runs.
    pub(super) position: i32,
    pub(super) page_id: u64,
    /// The page's own mark ids, in the order their annotations sit on it.
    pub(super) marks: Vec<u64>,
    pub(super) revision: u64,
    pub(super) owned: Option<OwnedTailState>,
    /// Whether the page came from a merge, so a restore puts it back into the
    /// merged-content set that forbids overwriting the first file.
    pub(super) merged: bool,
}

/// A 1-based page number as a zero-based index, if in range. Checked arithmetic:
/// the number is the WebView's, and must refuse rather than overflow.
pub(super) fn page_index(page_number: i32, page_count: usize) -> Option<usize> {
    page_number
        .checked_sub(1)
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| *index < page_count)
}

pub(super) fn validate_page_order(
    order: &[i32],
    page_count: usize,
) -> Result<Option<Vec<i32>>, String> {
    if order.len() != page_count {
        return Err("the page order must name every page exactly once".into());
    }

    let mut seen = vec![false; page_count];

    for &page_number in order {
        let Some(index) = page_index(page_number, page_count) else {
            return Err(format!("page {page_number} does not exist"));
        };

        if seen[index] {
            return Err(format!(
                "page {page_number} appears twice in the page order"
            ));
        }

        seen[index] = true;
    }

    if order
        .iter()
        .enumerate()
        .all(|(index, page_number)| *page_number == index as i32 + 1)
    {
        return Ok(None);
    }

    Ok(Some(
        order.iter().map(|page_number| page_number - 1).collect(),
    ))
}

pub(super) fn validate_pages_to_delete(
    page_numbers: &[i32],
    page_count: usize,
) -> Result<Vec<usize>, String> {
    if page_numbers.is_empty() {
        return Err("a deletion needs at least one page".into());
    }

    let mut seen = vec![false; page_count];

    for &page_number in page_numbers {
        let Some(index) = page_index(page_number, page_count) else {
            return Err(format!("page {page_number} does not exist"));
        };

        if seen[index] {
            return Err(format!("page {page_number} appears twice in the deletion"));
        }

        seen[index] = true;
    }

    if page_numbers.len() >= page_count {
        return Err("a document must keep at least one page".into());
    }

    Ok(seen
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| selected.then_some(index))
        .collect())
}

/// Checks the named pages exist and are distinct; hands back ascending indices.
/// Unlike a deletion, these actions may take the whole document at once.
pub(super) fn validate_distinct_pages(
    page_numbers: &[i32],
    page_count: usize,
    action: &str,
) -> Result<Vec<usize>, String> {
    if page_numbers.is_empty() {
        return Err(format!("{action} needs at least one page"));
    }

    let mut seen = vec![false; page_count];

    for &page_number in page_numbers {
        let Some(index) = page_index(page_number, page_count) else {
            return Err(format!("page {page_number} does not exist"));
        };

        if seen[index] {
            return Err(format!("page {page_number} appears twice in {action}"));
        }

        seen[index] = true;
    }

    Ok(seen
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| selected.then_some(index))
        .collect())
}

/// A page's `/Rotate` holds quarter turns and nothing else, so anything else
/// is refused rather than rounded to one: the number is the WebView's.
pub(super) fn quarter_turn(degrees: i32) -> Result<i32, String> {
    let turn = degrees.rem_euclid(360);

    if turn % 90 != 0 {
        return Err(format!("{degrees} is not a quarter turn"));
    }

    Ok(turn)
}

/// The `/Rotate` value for a clockwise turn in degrees, which `quarter_turn`
/// has already established is one of the four.
pub(super) fn quarter_turn_rotation(degrees: i32) -> PdfPageRenderRotation {
    match degrees.rem_euclid(360) {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// PDFium's page-range syntax for an import, as in "1,3,5-7"; built from
/// ascending indices, so copied pages land in the order the grid shows them.
pub(super) fn page_range_argument(indices: &[usize]) -> String {
    let run = |start: usize, end: usize| {
        if start == end {
            format!("{}", start + 1)
        } else {
            format!("{}-{}", start + 1, end + 1)
        }
    };
    let mut ranges = Vec::new();
    let mut open: Option<(usize, usize)> = None;

    for &index in indices {
        open = match open {
            Some((start, end)) if index == end + 1 => Some((start, index)),
            Some((start, end)) => {
                ranges.push(run(start, end));
                Some((index, index))
            }
            None => Some((index, index)),
        };
    }

    if let Some((start, end)) = open {
        ranges.push(run(start, end));
    }

    ranges.join(",")
}

impl PdfiumEngine {
    /// Rearranges the pages into `order` — the current 1-based page numbers in
    /// their new sequence. The identity order changes nothing and bumps nothing.
    pub(in crate::pdfium) fn reorder_pages(
        &self,
        document_id: u64,
        order: &[i32],
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let Some(indices) = validate_page_order(order, entry.page_ids.len())? else {
            return Ok(structure_update(entry));
        };

        // A failed FPDF_MovePages may leave the document in an indeterminate
        // state, so even a pure move takes the M6 snapshot precaution.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        if let Err(error) = entry.document.pages_mut().move_pages(&indices, 0) {
            return Err(self.restore_document_snapshot(
                entry,
                snapshot,
                format!("PDFium could not reorder the pages: {error}"),
            ));
        }

        entry.page_ids = indices
            .iter()
            .map(|index| entry.page_ids[*index as usize])
            .collect();

        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// Turns pages clockwise on top of what each carries. Alone among structure
    /// commands it moves no page: the turn is each page's rewritten `/Rotate`.
    pub(in crate::pdfium) fn rotate_pages(
        &self,
        document_id: u64,
        page_numbers: &[i32],
        degrees: i32,
    ) -> Result<PdfStructureUpdate, String> {
        let turn = quarter_turn(degrees)?;
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let indices = validate_distinct_pages(page_numbers, entry.page_ids.len(), "a rotation")?;

        if turn == 0 {
            return Ok(structure_update(entry));
        }

        // Every page is read before any is turned: a load failure refuses the
        // whole edit, since SetRotation cannot fail once the page is in hand.
        let mut turned = Vec::with_capacity(indices.len());

        for index in &indices {
            let page =
                entry.document.pages().get(*index as i32).map_err(|error| {
                    format!("PDFium could not load page {}: {error}", index + 1)
                })?;

            turned.push(quarter_turn_rotation(
                page_rotation_degrees(&page) as i32 + turn,
            ));
        }

        for (index, rotation) in indices.iter().zip(turned) {
            let measured = {
                let mut page = entry
                    .document
                    .pages_mut()
                    .get(*index as i32)
                    .map_err(|error| {
                        format!("PDFium could not load page {}: {error}", index + 1)
                    })?;

                page.set_rotation(rotation);
                // PDFium updates the dimensions as it sets the rotation, so
                // reading here spares `page_infos` a second load of each page.
                measure_page(&page)
            };
            let page_id = entry.page_ids[*index];

            // The one edit that re-shapes a page: it writes the geometry memo,
            // others only fill it, and bumps the revision, page by page.
            entry.page_geometry.insert(page_id, measured);
            *entry.revisions.entry(page_id).or_insert(0) += 1;
        }

        Ok(structure_update(entry))
    }

    /// Deletes the given pages, first copying them — and the session state
    /// with them — into a stash under `stash_id` for a later restore.
    pub(in crate::pdfium) fn delete_pages(
        &self,
        document_id: u64,
        page_numbers: &[i32],
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let indices = validate_pages_to_delete(page_numbers, entry.page_ids.len())?;

        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        let stashed = (|| -> Result<PdfDocument<'static>, String> {
            let mut stash_document = self
                .pdfium
                .create_new_pdf()
                .map_err(|error| format!("PDFium could not prepare the page stash: {error}"))?;
            let range = indices
                .iter()
                .map(|index| (index + 1).to_string())
                .collect::<Vec<_>>()
                .join(",");

            stash_document
                .pages_mut()
                .copy_pages_from_document(&entry.document, &range, 0)
                .map_err(|error| format!("PDFium could not copy the pages aside: {error}"))?;

            // Descending, so each deletion leaves the shallower indices true.
            for index in indices.iter().rev() {
                entry
                    .document
                    .pages_mut()
                    .get(*index as i32)
                    .map_err(|error| format!("PDFium could not load page {}: {error}", index + 1))?
                    .delete()
                    .map_err(|error| {
                        format!("PDFium could not delete page {}: {error}", index + 1)
                    })?;
            }

            Ok(stash_document)
        })();
        let stash_document = match stashed {
            Ok(document) => document,
            Err(error) => return Err(self.restore_document_snapshot(entry, snapshot, error)),
        };

        let mut pages = Vec::with_capacity(indices.len());

        for index in indices.iter().rev() {
            let page_id = entry.page_ids.remove(*index);

            pages.push(StashedPage {
                position: *index as i32 + 1,
                page_id,
                marks: entry.marks.remove(&page_id).unwrap_or_default(),
                revision: entry.revisions.remove(&page_id).unwrap_or(0),
                owned: entry
                    .owned_content
                    .as_mut()
                    .and_then(|state| state.per_page.remove(&page_id)),
                // A deleted merged page leaves the document; the guard follows.
                merged: entry.merged_page_ids.remove(&page_id),
            });
        }
        // Ascending — the order their copies sit in the stash document.
        pages.reverse();

        entry.stashes.insert(
            stash_id,
            PageStash {
                document: stash_document,
                pages,
            },
        );
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    pub(in crate::pdfium) fn restore_pages(
        &self,
        document_id: u64,
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let Some(stash) = entry.stashes.remove(&stash_id) else {
            return Err("there are no stashed pages under this undo entry".into());
        };

        // LIFO undo should have the document back in shape, but the caller is a
        // browser: prove every recorded position fits before touching PDFium.
        let fits = stash.pages.iter().enumerate().all(|(offset, stashed)| {
            stashed.position >= 1 && stashed.position as usize <= entry.page_ids.len() + offset + 1
        });

        if !fits {
            entry.stashes.insert(stash_id, stash);
            return Err("the stashed pages do not fit this document".into());
        }

        let snapshot = match entry.document.save_to_bytes() {
            Ok(bytes) => bytes,
            Err(error) => {
                entry.stashes.insert(stash_id, stash);
                return Err(format!("PDFium could not snapshot the document: {error}"));
            }
        };
        let restored = (|| -> Result<(), String> {
            for (offset, stashed) in stash.pages.iter().enumerate() {
                entry
                    .document
                    .pages_mut()
                    .copy_page_from_document(&stash.document, offset as i32, stashed.position - 1)
                    .map_err(|error| {
                        format!(
                            "PDFium could not restore page {}: {error}",
                            stashed.position
                        )
                    })?;
            }

            Ok(())
        })();

        if let Err(error) = restored {
            let cause = self.restore_document_snapshot(entry, snapshot, error);

            entry.stashes.insert(stash_id, stash);
            return Err(cause);
        }

        let mut next_page_ids = entry.page_ids.clone();

        for stashed in &stash.pages {
            next_page_ids.insert(stashed.position as usize - 1, stashed.page_id);
        }

        // The copies came back through FPDF_ImportPages; prove every owned
        // layer's tail survived the round trip before accepting the document.
        if let Some(state) = &entry.owned_content {
            let mut prospective = state.clone();

            for stashed in &stash.pages {
                if let Some(tail) = &stashed.owned {
                    prospective.per_page.insert(stashed.page_id, tail.clone());
                }
            }

            if let Err(error) =
                Self::verify_owned_tail(&entry.document, &next_page_ids, &prospective)
            {
                let cause = self.restore_document_snapshot(
                    entry,
                    snapshot,
                    format!("the restored pages no longer carry this session's marks: {error}"),
                );

                entry.stashes.insert(stash_id, stash);
                return Err(cause);
            }

            entry.owned_content = Some(prospective);
        }

        entry.page_ids = next_page_ids;
        for stashed in &stash.pages {
            if !stashed.marks.is_empty() {
                entry.marks.insert(stashed.page_id, stashed.marks.clone());
            }

            if stashed.merged {
                entry.merged_page_ids.insert(stashed.page_id);
            }

            entry.revisions.insert(stashed.page_id, stashed.revision);
        }

        // The delete already set this, and the import may leave orphans of its
        // own; keep the next write on the compacting path either way.
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// Inserts a blank page at 1-based `index`, sized from the unrotated
    /// dimensions of the page that will follow it — or precede it, at the end.
    pub(in crate::pdfium) fn insert_blank_page(
        &self,
        document_id: u64,
        index: i32,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_count = entry.page_ids.len();
        // One past the end is a position too, so the check is page_index's
        // with the count stretched by one.
        let Some(slot) = page_index(index, page_count + 1) else {
            return Err(format!("a page cannot go to position {index}"));
        };

        // The size is read off the neighbour under the lock, never taken from
        // the WebView.
        let neighbor_index = slot.min(page_count.saturating_sub(1));
        let (width, height) = {
            let page = entry
                .document
                .pages()
                .get(neighbor_index as i32)
                .map_err(|error| {
                    format!("PDFium could not load page {}: {error}", neighbor_index + 1)
                })?;

            unrotated_page_size(&page)
        };
        let page = entry
            .document
            .pages_mut()
            .create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(width), PdfPoints::new(height)),
                slot as i32,
            )
            .map_err(|error| format!("PDFium could not create the blank page: {error}"))?;

        drop(page);

        let page_id = entry.next_page_id;

        entry.next_page_id += 1;
        entry.page_ids.insert(slot, page_id);

        if let Some(state) = entry.owned_content.as_mut() {
            // Owned but bare: no layer covers a page inserted after an apply,
            // and a blank page has no content of its own to base on.
            state.per_page.insert(
                page_id,
                OwnedTailState {
                    base_objects: 0,
                    segments: Vec::new(),
                },
            );
        }

        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// Inserts every page of the PDF at `path` as one edit, under the same
    /// limits as a fresh open; its pages become this document's own.
    pub(in crate::pdfium) fn insert_from_path(
        &self,
        document_id: u64,
        path: PathBuf,
        index: i32,
    ) -> Result<InsertOutcome, String> {
        // The same read an open makes, under the same MiB ceiling: an insert is
        // another door onto a reader's file, not a looser one.
        let bytes = read_pdf_bytes(&path)?;

        let mut documents = self.lock_documents()?;
        // Opened inside the lock — loading is PDFium work — and dropped at
        // scope's end, never entering the store; errors worded like `open`'s.
        let source = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|error| format!("PDFium could not open the document: {error}"))?;
        let added_count = source.pages().len();

        if added_count < 1 {
            return Err("the inserted PDF has no pages".into());
        }

        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_count = entry.page_ids.len();
        // One past the end is a position too, exactly as a blank page's is.
        let Some(slot) = page_index(index, page_count + 1) else {
            return Err(format!("a page cannot go to position {index}"));
        };

        // The import may fail partway; snapshot first so a failure rolls the
        // document back whole, as every multi-page structure change does.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        if let Err(error) = entry.document.pages_mut().copy_page_range_from_document(
            &source,
            0..=added_count - 1,
            slot as i32,
        ) {
            return Err(self.restore_document_snapshot(
                entry,
                snapshot,
                format!("PDFium could not insert the document: {error}"),
            ));
        }

        if let Err(error) =
            Self::record_inserted_pages(entry, slot, &vec![true; added_count as usize])
        {
            return Err(self.restore_document_snapshot(entry, snapshot, error));
        }

        // Nothing was removed, so no compaction is owed; but content moved, so
        // an effect captured before the insert fails its revision check.
        entry.invalidate_all_page_revisions();

        Ok(InsertOutcome {
            page_count: added_count,
            update: structure_update(entry),
        })
    }

    /// Records a copy's pages into bookkeeping; everything failable is measured
    /// first, so an error leaves the entry as it was.
    pub(super) fn record_inserted_pages(
        entry: &mut OpenDocument,
        slot: usize,
        merged: &[bool],
    ) -> Result<(), String> {
        let count = merged.len();
        // What the document really grew by, rather than what was asked for:
        // `page_ids` is the list every later command trusts against.
        let grown_by = (entry.document.pages().len() as usize).saturating_sub(entry.page_ids.len());

        if grown_by != count {
            return Err(format!(
                "PDFium added {grown_by} pages where {count} were asked for"
            ));
        }

        // A copied page carries its source's content; with a layer owned, each
        // new page takes an owned-but-bare record based on that content.
        let mut new_base_objects = match &entry.owned_content {
            Some(_) => (0..count)
                .map(|offset| {
                    let index = (slot + offset) as i32;
                    entry
                        .document
                        .pages()
                        .get(index)
                        .map(|page| page.objects().len())
                        .map_err(|error| {
                            format!(
                                "PDFium could not inspect inserted page {}: {error}",
                                index + 1
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        }
        .into_iter();

        for (offset, &from_elsewhere) in merged.iter().enumerate() {
            let page_id = entry.next_page_id;

            entry.next_page_id += 1;
            entry.page_ids.insert(slot + offset, page_id);

            // This page holds content from outside this document's own file:
            // while it stays, that file may only be exported to, never saved.
            if from_elsewhere {
                entry.merged_page_ids.insert(page_id);
            }

            if let Some(state) = entry.owned_content.as_mut() {
                state.per_page.insert(
                    page_id,
                    OwnedTailState {
                        base_objects: new_base_objects
                            .next()
                            .expect("one measured base count per inserted page"),
                        segments: Vec::new(),
                    },
                );
            }
        }

        Ok(())
    }

    /// The cross-tab thumbnail drag: pages copied from another open document as
    /// the reader has it, marks and all, export-only like an inserted file's.
    pub(in crate::pdfium) fn insert_pages_from_document(
        &self,
        document_id: u64,
        source_document_id: u64,
        page_numbers: &[i32],
        index: i32,
    ) -> Result<PdfStructureUpdate, String> {
        // Both a real refusal and what makes the two entries below disjoint.
        // Within one document a drag reorders, which is a different command.
        if document_id == source_document_id {
            return Err("a document cannot take pages from itself".into());
        }

        let mut documents = self.lock_documents()?;
        let source_count = open_entry(&documents, source_document_id)?.page_ids.len();
        let source_pages = validate_distinct_pages(page_numbers, source_count, "an insert")?;
        let page_count = open_entry(&documents, document_id)?.page_ids.len();
        // One past the end is a position too, exactly as a blank page's is.
        let Some(slot) = page_index(index, page_count + 1) else {
            return Err(format!("a page cannot go to position {index}"));
        };

        let [Some(entry), Some(source)] =
            documents.get_disjoint_mut([&document_id, &source_document_id])
        else {
            return Err("PDF document is no longer open".into());
        };

        // The import may fail partway; snapshot first so a failure rolls the
        // document back whole, as every multi-page structure change does.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        if let Err(error) = entry.document.pages_mut().copy_pages_from_document(
            &source.document,
            &page_range_argument(&source_pages),
            slot as i32,
        ) {
            return Err(self.restore_document_snapshot(
                entry,
                snapshot,
                format!("PDFium could not insert the pages: {error}"),
            ));
        }

        if let Err(error) =
            Self::record_inserted_pages(entry, slot, &vec![true; source_pages.len()])
        {
            return Err(self.restore_document_snapshot(entry, snapshot, error));
        }

        // Every page's content now sits in a longer document, so an M5 effect
        // captured before this must fail its revision check after it.
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// The grid's copy-and-paste; PDFium cannot import into itself, so the
    /// pages detour through a scratch document, as a delete's stash does.
    pub(in crate::pdfium) fn duplicate_pages(
        &self,
        document_id: u64,
        page_numbers: &[i32],
        index: i32,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let page_count = entry.page_ids.len();
        let sources = validate_distinct_pages(page_numbers, page_count, "an insert")?;
        // One past the end is a position too, exactly as a blank page's is.
        let Some(slot) = page_index(index, page_count + 1) else {
            return Err(format!("a page cannot go to position {index}"));
        };

        // The copy may fail partway; snapshot first so a failure rolls the
        // document back whole, as every multi-page structure change does.
        let snapshot = entry
            .document
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;

        let copied = (|| -> Result<(), String> {
            let mut scratch = self
                .pdfium
                .create_new_pdf()
                .map_err(|error| format!("PDFium could not prepare the copies: {error}"))?;

            scratch
                .pages_mut()
                .copy_pages_from_document(&entry.document, &page_range_argument(&sources), 0)
                .map_err(|error| format!("PDFium could not copy the pages aside: {error}"))?;

            entry
                .document
                .pages_mut()
                .copy_page_range_from_document(
                    &scratch,
                    0..=(sources.len() - 1) as i32,
                    slot as i32,
                )
                .map_err(|error| format!("PDFium could not insert the copies: {error}"))
        })();

        if let Err(error) = copied {
            return Err(self.restore_document_snapshot(entry, snapshot, error));
        }

        // Read while `page_ids` still stands as the sources were named: a copy
        // of a page this document may not be saved over is one too.
        let merged: Vec<bool> = sources
            .iter()
            .map(|source| {
                let page_id = entry.page_ids[*source];

                entry.merged_page_ids.contains(&page_id)
                    || entry.owned_content.as_ref().is_some_and(|state| {
                        state
                            .per_page
                            .get(&page_id)
                            .is_some_and(|tail| !tail.segments.is_empty())
                    })
            })
            .collect();

        if let Err(error) = Self::record_inserted_pages(entry, slot, &merged) {
            return Err(self.restore_document_snapshot(entry, snapshot, error));
        }

        // Every page's content now sits in a longer document, so an M5 effect
        // captured before this must fail its revision check after it.
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }
}
