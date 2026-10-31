use super::owned_content::OwnedTailState;
use super::*;

/// A deleted page's copy and its session state, held so an undo can put both
/// back exactly — self-contained, in a document of its own, released with it.
pub(super) struct PageStash {
    pub(super) document: PdfDocument<'static>,
    /// One record per deleted page, ascending by original position — the order
    /// their copies sit in `document`, and the order a restore reinserts them.
    pub(super) pages: Vec<StashedPage>,
    /// Bookmarks aimed at a deleted page, which a restore points at its copy.
    pub(super) bookmarks: Vec<outline::Relink>,
}

/// The bookmarks whose target is one of `pages` (0-based), by place in the tree.
fn bookmarks_on_pages(
    items: &[PdfOutlineItem],
    pages: &HashSet<usize>,
    path: &mut Vec<usize>,
    found: &mut Vec<outline::Relink>,
) {
    for (index, item) in items.iter().enumerate() {
        path.push(index);

        if let Some(page) = item
            .page_number
            .and_then(|number| usize::try_from(number - 1).ok())
            .filter(|page| pages.contains(page))
        {
            found.push(outline::Relink {
                path: path.clone(),
                page,
            });
        }

        bookmarks_on_pages(&item.items, pages, path, found);
        path.pop();
    }
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
    /// Whether the page is a copy of owned content, so a restore puts it
    /// back into the set that forbids overwriting the document's file.
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
    pub fn reorder_pages(
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

        if let Err(error) =
            super::page_reorder::move_pages(self.raw_bindings, &mut entry.document, &indices)
        {
            return Err(self.restore_document_snapshot(entry, snapshot, error));
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
    pub fn rotate_pages(
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
            entry.bump_page_revision(page_id);
        }

        Ok(structure_update(entry))
    }

    /// Deletes the given pages, first copying them — and the session state
    /// with them — into a stash under `stash_id` for a later restore.
    pub fn delete_pages(
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

        let mut bookmarks = Vec::new();
        bookmarks_on_pages(
            &collect_bookmark_siblings(entry.document.bookmarks().root()),
            &indices.iter().copied().collect(),
            &mut Vec::new(),
            &mut bookmarks,
        );

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
                // A deleted copy leaves the document; the guard follows it out.
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
                bookmarks,
            },
        );
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// The restored pages are copies, so a bookmark aimed at a deleted page
    /// still names the old object. Best effort: the pages are back either way,
    /// and a failure here leaves only the bookmark unresolved, as before.
    fn relink_restored_bookmarks(&self, entry: &mut OpenDocument, bookmarks: &[outline::Relink]) {
        if bookmarks.is_empty() {
            return;
        }

        let outline = collect_bookmark_siblings(entry.document.bookmarks().root());
        let dangling: Vec<outline::Relink> = bookmarks
            .iter()
            .filter(|relink| {
                let mut items = outline.as_slice();
                let mut found = None;

                for &index in &relink.path {
                    found = items.get(index);
                    items = found.map_or(&[], |item| item.items.as_slice());
                }

                found.is_some_and(|item| item.page_number.is_none())
            })
            .cloned()
            .collect();

        if dangling.is_empty() {
            return;
        }

        let Ok(bytes) = entry.document.save_to_bytes() else {
            return;
        };
        let Ok(Some(bytes)) = outline::relink_pages(&bytes, &dangling) else {
            return;
        };
        let Ok(reloaded) = self.pdfium.load_pdf_from_byte_vec(bytes, None) else {
            return;
        };

        if reloaded.pages().len() as usize != entry.page_ids.len() {
            return;
        }

        if let Some(state) = &entry.owned_content {
            if Self::verify_owned_tail(&reloaded, &entry.page_ids, state, None, &mut |_, _| {})
                .is_err()
            {
                return;
            }
        }

        entry.document = reloaded;
    }

    /// Drops the stashes of undone inserts the reader has branched away from:
    /// no redo can reach them, and each holds a copy of its pages. An id with
    /// no stash is nothing to drop, which a repeated discard is.
    pub fn discard_stashes(&self, document_id: u64, stash_ids: &[u64]) -> Result<(), String> {
        // Closing a stash's document is PDFium work, so under the store's lock.
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        for stash_id in stash_ids {
            entry.stashes.remove(stash_id);
        }

        Ok(())
    }

    pub fn restore_pages(
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
                // An undo step, with no Stop to offer: checked in one pass.
                Self::verify_owned_tail(
                    &entry.document,
                    &next_page_ids,
                    &prospective,
                    None,
                    &mut |_, _| {},
                )
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

        self.relink_restored_bookmarks(entry, &stash.bookmarks);

        // The delete already set this, and the import may leave orphans of its
        // own; keep the next write on the compacting path either way.
        entry.needs_compaction = true;
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// Inserts a blank page at 1-based `index`, sized from the unrotated
    /// dimensions of the page that will follow it — or precede it, at the end.
    pub fn insert_blank_page(
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

        for (offset, &copy_only) in merged.iter().enumerate() {
            let page_id = entry.next_page_id;

            entry.next_page_id += 1;
            entry.page_ids.insert(slot + offset, page_id);

            // A copy of owned content, out of the layers' reach: while it
            // stays, the document's file may only be exported to, never saved.
            if copy_only {
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

    /// The sidebar's copy-and-paste; PDFium cannot import into itself, so the
    /// pages detour through a scratch document, as a delete's stash does.
    pub fn duplicate_pages(
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
