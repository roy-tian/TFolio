//! The organize workspace's sources: files read for their pages, never
//! edited, and only ever copied into a new document by `assemble_pdf`.

use serde::{Deserialize, Serialize};

use super::io::{
    append_page_fitted_to_a4, fingerprint, is_merge_image, load_merge_source,
    merge_file_limit_error, read_merge_source, Fingerprint, MergeDraft, SourceFile,
    MAX_MERGE_FILES,
};
use super::page_ops::{page_index, page_range_argument, quarter_turn, quarter_turn_rotation};
use super::page_reorder::move_pages;
use super::*;

/// Bytes of sources kept parsed at once, every window's together; the rest
/// are read again from disk when a thumbnail or an assembly next needs them.
const OPEN_SOURCE_BUDGET: usize = 512 * 1024 * 1024;
const MAX_ASSEMBLE_PAGES: usize = 20_000;
const MAX_OUTLINE_ITEMS: usize = 10_000;
const MAX_OUTLINE_DEPTH: usize = 32;
/// PDF's own ceiling on a page side without a user unit, in points.
const MAX_PAGE_SIDE: f32 = 14_400.0;
const MIN_PAGE_SIDE: f32 = 3.0;

/// What the frontend matches to tell the reader to add the file again.
pub const ORGANIZE_SOURCE_CHANGED: &str = "the file changed since it was added";

struct OrganizeSource {
    scope: String,
    /// The reader's own file: what the fingerprint guards and errors name.
    path: PathBuf,
    /// What PDFium reads: a Word document's conversion, otherwise the file.
    read_from: PathBuf,
    fingerprint: Fingerprint,
    page_count: usize,
    /// Its signatures intact on disk: no write may replace it while added.
    signed: bool,
}

struct OpenSource {
    id: u64,
    document: PdfDocument<'static>,
    cost: usize,
}

/// Every document here is PDFium's, touched and dropped only inside the
/// documents lock; the entries alone may be read without it.
#[derive(Default)]
pub(super) struct OrganizeSources {
    entries: HashMap<u64, OrganizeSource>,
    /// Least recently used first.
    open: Vec<OpenSource>,
}

impl OrganizeSources {
    pub(super) fn is_signed_source(&self, path: &Path) -> bool {
        self.entries
            .values()
            .any(|source| source.signed && same_file(&source.path, path))
    }

    fn entry(&self, scope: &str, id: u64) -> Result<&OrganizeSource, String> {
        self.entries
            .get(&id)
            .filter(|entry| entry.scope == scope)
            .ok_or_else(|| format!("source {id} is not one of this window's"))
    }

    fn touch(&mut self, id: u64) -> Option<&PdfDocument<'static>> {
        let position = self.open.iter().position(|open| open.id == id)?;
        let open = self.open.remove(position);

        self.open.push(open);
        self.open.last().map(|open| &open.document)
    }

    /// The newest always stays, however large: a file over the budget alone
    /// is still one the reader can organize.
    fn keep_open(&mut self, id: u64, document: PdfDocument<'static>, cost: usize) {
        self.open.push(OpenSource { id, document, cost });

        let mut total: usize = self.open.iter().map(|open| open.cost).sum();

        while total > OPEN_SOURCE_BUDGET && self.open.len() > 1 {
            total -= self.open.remove(0).cost;
        }
    }

    fn ids_in(&self, scope: &str) -> Vec<u64> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.scope == scope)
            .map(|(id, _)| *id)
            .collect()
    }

    fn remove(&mut self, id: u64) {
        self.entries.remove(&id);
        self.open.retain(|open| open.id != id);
    }
}

fn source_cost(file: &SourceFile) -> usize {
    match file {
        SourceFile::Pdf(bytes) => bytes.len(),
        // PDFium keeps the decoded bitmap, not the file it came from.
        SourceFile::Image(image) => image.width() as usize * image.height() as usize * 4,
    }
}

/// What the workspace learns of a file it adds; `id` is absent where the file
/// could not be read, and `error` then says why where "unreadable" would not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeSourceInfo {
    pub(super) path: String,
    pub(super) kind: MergeSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id: Option<u64>,
    pub(super) pages: Vec<PdfPageInfo>,
    pub(super) outline: Vec<PdfOutlineItem>,
    pub(super) signatures: PdfSignatures,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<MergeSourceError>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssembleSlot {
    /// `turn` is clockwise, on top of the page's own `/Rotate`.
    Page {
        source_id: u64,
        page_number: i32,
        turn: i32,
    },
    Blank {
        width: f32,
        height: f32,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleOutlineItem {
    pub title: String,
    /// 1-based, in the assembled document.
    pub page_number: i32,
    #[serde(default)]
    pub items: Vec<AssembleOutlineItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssemblePlan {
    pub slots: Vec<AssembleSlot>,
    pub normalize_a4: bool,
    pub outline: Vec<AssembleOutlineItem>,
    pub watermark: Option<WatermarkConfig>,
    pub page_numbers: Option<PageNumbersConfig>,
    /// What becomes of signed sources' signatures, which a new document
    /// cannot keep; required while any slot takes a page from one.
    #[serde(default)]
    pub signatures: Option<SignatureDecision>,
}

/// The outline as `write_outline` takes it, refusing what no workspace sends.
fn outline_nodes(
    items: Vec<AssembleOutlineItem>,
    page_count: usize,
    depth: usize,
    budget: &mut usize,
) -> Result<Vec<OutlineNode>, String> {
    if depth > MAX_OUTLINE_DEPTH {
        return Err(format!("bookmarks nest at most {MAX_OUTLINE_DEPTH} deep"));
    }

    items
        .into_iter()
        .map(|item| {
            if *budget == 0 {
                return Err(format!(
                    "an outline holds at most {MAX_OUTLINE_ITEMS} bookmarks"
                ));
            }

            *budget -= 1;

            let Some(index) = page_index(item.page_number, page_count) else {
                return Err(format!("bookmark page {} does not exist", item.page_number));
            };

            Ok(OutlineNode {
                title: item.title,
                page: index,
                children: outline_nodes(item.items, page_count, depth + 1, budget)?,
            })
        })
        .collect()
}

/// A source's page slots, as (position in the plan, page number).
type SourcePages = (u64, Vec<(usize, i32)>);

/// The plan's page slots by source, in the order each source first appears.
fn slots_by_source(slots: &[AssembleSlot]) -> Vec<SourcePages> {
    let mut groups: Vec<SourcePages> = Vec::new();
    let mut group_of: HashMap<u64, usize> = HashMap::new();

    for (position, slot) in slots.iter().enumerate() {
        if let AssembleSlot::Page {
            source_id,
            page_number,
            ..
        } = *slot
        {
            let group = *group_of.entry(source_id).or_insert_with(|| {
                groups.push((source_id, Vec::new()));
                groups.len() - 1
            });

            groups[group].1.push((position, page_number));
        }
    }

    groups
}

fn valid_side(side: f32) -> bool {
    side.is_finite() && (MIN_PAGE_SIDE..=MAX_PAGE_SIDE).contains(&side)
}

impl PdfiumEngine {
    pub(super) fn lock_organize(&self) -> MutexGuard<'_, OrganizeSources> {
        // Bookkeeping like the operations list: a poisoned lock must not leave
        // every later source unreadable.
        self.organize
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads each file just far enough to show its pages, keeping it parsed
    /// while the budget allows. An unreadable file is reported, not dropped.
    pub fn add_organize_sources(
        &self,
        scope: &str,
        paths: Vec<PathBuf>,
        word_conversion: bool,
    ) -> Result<Vec<OrganizeSourceInfo>, String> {
        if paths.len() > MAX_MERGE_FILES {
            return Err(merge_file_limit_error());
        }

        // Stoppable under the inspection's target: the same Stop asks an
        // office suite to give up, whichever flow started it.
        let operation = self.begin_operation(OperationTarget::Convert(scope.to_string()));
        let cancelled = || operation.is_cancelled();
        let word = self.resolve_word_documents(&paths, word_conversion, &cancelled, &mut || {});

        Ok(paths
            .into_iter()
            .zip(word)
            .take_while(|_| !cancelled())
            .map_while(|(path, word)| self.add_organize_source(scope, path, word, &cancelled))
            .collect())
    }

    /// `None` once the scope's work is stopped, keeping nothing.
    fn add_organize_source(
        &self,
        scope: &str,
        path: PathBuf,
        word: crate::convert::Entry,
        cancelled: &dyn Fn() -> bool,
    ) -> Option<OrganizeSourceInfo> {
        let kind = match word {
            crate::convert::Entry::NotWord if is_merge_image(&path) => MergeSourceKind::Image,
            crate::convert::Entry::NotWord => MergeSourceKind::Pdf,
            _ => MergeSourceKind::Word,
        };
        let refused = |error: Option<MergeSourceError>| {
            Some(OrganizeSourceInfo {
                path: path.to_string_lossy().into_owned(),
                kind,
                id: None,
                pages: Vec::new(),
                outline: Vec::new(),
                signatures: PdfSignatures::default(),
                error,
            })
        };
        let read_from = match word {
            crate::convert::Entry::Converted(pdf) => pdf,
            crate::convert::Entry::Failed(crate::convert::ConvertError::NoConverter) => {
                return refused(Some(MergeSourceError::ConverterMissing))
            }
            crate::convert::Entry::Failed(_) => {
                return refused(Some(MergeSourceError::ConversionFailed))
            }
            crate::convert::Entry::NotWord => path.clone(),
        };
        // A conversion that PDFium then cannot read failed all the same.
        let unreadable =
            matches!(kind, MergeSourceKind::Word).then_some(MergeSourceError::ConversionFailed);
        let Some(fingerprint) = fingerprint(&path) else {
            return refused(unreadable);
        };
        // Read and decoded off the lock, which only PDFium's part needs.
        let Ok(file) = read_merge_source(&read_from) else {
            return refused(unreadable);
        };
        let cost = source_cost(&file);
        let Ok(documents) = self.lock_documents() else {
            return refused(unreadable);
        };

        // Read under the lock a window's release takes, which its host takes
        // only after stopping this: a source kept past it would never go.
        if cancelled() {
            return None;
        }

        let Ok(document) = load_merge_source(self.pdfium, file, &read_from) else {
            return refused(unreadable);
        };
        let mut layout = document_layout(&document);

        if layout.num_pages < 1 {
            return refused(unreadable);
        }

        // A conversion is this app's own output, never a signed file.
        let scan =
            matches!(kind, MergeSourceKind::Pdf).then(|| signatures::SignatureScan::of(&document));

        if let Some(scan) = &scan {
            signatures::mark_signature_pages(scan, &document, &mut layout.pages);
        }

        let mut organize = self.lock_organize();
        let id = self.next_organize_id.fetch_add(1, Ordering::Relaxed);

        organize.entries.insert(
            id,
            OrganizeSource {
                scope: scope.to_string(),
                path: path.clone(),
                read_from,
                fingerprint,
                page_count: layout.num_pages as usize,
                signed: false,
            },
        );
        organize.keep_open(id, document, cost);
        drop(organize);
        drop(documents);

        let signed = scan.as_ref().is_some_and(|scan| {
            scan.intact_in(&signatures::OpenedFile {
                path: path.clone(),
                fingerprint,
            })
        });

        if signed {
            if let Some(source) = self.lock_organize().entries.get_mut(&id) {
                source.signed = true;
            }
        }

        Some(OrganizeSourceInfo {
            path: path.to_string_lossy().into_owned(),
            kind,
            id: Some(id),
            pages: layout.pages,
            outline: layout.outline,
            signatures: scan.map_or_else(PdfSignatures::default, |scan| scan.summary(signed)),
            error: None,
        })
    }

    /// Runs `work` under the documents lock with source `id` parsed, reading it
    /// again — off the lock — if the budget let it go.
    fn with_organize_source<T>(
        &self,
        scope: &str,
        id: u64,
        work: impl FnOnce(
            &mut HashMap<u64, OpenDocument>,
            &PdfDocument<'static>,
            &Path,
        ) -> Result<T, String>,
    ) -> Result<T, String> {
        let (path, read_from, recorded, page_count) = {
            let mut documents = self.lock_documents()?;
            let mut organize = self.lock_organize();
            let entry = organize.entry(scope, id)?;
            let facts = (
                entry.path.clone(),
                entry.read_from.clone(),
                entry.fingerprint,
                entry.page_count,
            );

            if let Some(document) = organize.touch(id) {
                return work(&mut documents, document, &facts.0);
            }

            facts
        };

        // Its pages are what the workspace already arranged: a file that has
        // changed since, or gone, may have others, or fewer.
        if fingerprint(&path) != Some(recorded) {
            return Err(ORGANIZE_SOURCE_CHANGED.into());
        }

        let file = read_merge_source(&read_from)?;
        let cost = source_cost(&file);
        let mut documents = self.lock_documents()?;
        let mut organize = self.lock_organize();

        // Released, or read back by another call, while this one read the disk.
        organize.entry(scope, id)?;

        if organize.touch(id).is_none() {
            let document = load_merge_source(self.pdfium, file, &read_from)?;

            if document.pages().len() as usize != page_count {
                return Err(ORGANIZE_SOURCE_CHANGED.into());
            }

            organize.keep_open(id, document, cost);
        }

        let document = organize.touch(id).expect("the source was just kept open");

        work(&mut documents, document, &path)
    }

    pub fn render_organize_thumbnail(
        &self,
        scope: &str,
        source_id: u64,
        page_number: i32,
        width: i32,
    ) -> Result<RgbImage, String> {
        if !(MIN_RENDER_WIDTH..=MAX_THUMBNAIL_WIDTH).contains(&width) {
            return Err(format!(
                "render width must be between {MIN_RENDER_WIDTH} and {MAX_THUMBNAIL_WIDTH} pixels"
            ));
        }

        let raw = self.with_organize_source(scope, source_id, |_, document, _| {
            let pages = document.pages();
            // Checked before the subtraction, which overflows under the lock.
            let index = page_index(page_number, pages.len() as usize)
                .ok_or_else(|| format!("page {page_number} does not exist"))?;
            let page = pages
                .get(index as PdfPageIndex)
                .map_err(|error| format!("PDFium could not load page {page_number}: {error}"))?;

            Self::render_page_raw(&page, width, MAX_THUMBNAIL_WIDTH)
        })?;

        raw.into_rgb()
    }

    /// Lets every parsed source go, as the budget would, so the next use reads
    /// the disk again.
    #[cfg(test)]
    pub(super) fn evict_organize_sources_for_test(&self, scope: &str) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut organize = self.lock_organize();
        let ids = organize.ids_in(scope);

        organize.open.retain(|open| !ids.contains(&open.id));
    }

    /// Lets go of sources read for a document they never reached: a prompt
    /// declined, an insert refused. Another window's ids are passed over.
    pub fn release_organize_sources(&self, scope: &str, ids: &[u64]) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut organize = self.lock_organize();

        for id in ids {
            if organize.entry(scope, *id).is_ok() {
                organize.remove(*id);
            }
        }
    }

    /// Where a release taken now must stop: read without a lock, so a window
    /// event can take it while an assembly holds every PDFium lock.
    pub fn organize_release_cutoff(&self) -> u64 {
        self.next_organize_id.load(Ordering::Relaxed)
    }

    /// A window's sources have nowhere to be shown once it is gone. Stop the
    /// scope's work first (`cancel_scope_work`), so an add still running
    /// keeps nothing after this. Only ids below `before` go: a release that
    /// waited for the lock must spare what the reloaded page has added since.
    pub fn release_organize_scope(&self, scope: &str, before: u64) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut organize = self.lock_organize();
        let ids = organize.ids_in(scope);

        for id in ids.into_iter().filter(|id| *id < before) {
            organize.remove(id);
        }
    }

    /// Adds files `add_organize_sources` read to an open document, all before
    /// 1-based `index`, each a file of its own and in order; the sources go
    /// once their pages are in. One step: the caller's undo deletes the whole
    /// run under its stash. A signed source needs `decision`, which a new file
    /// would ask for: its signatures cannot hold in this document either.
    /// `own_title` names the document's own pages, should this be the first
    /// file added, and `per_file_bookmarks` how a Save As writes the files.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_organize_sources(
        &self,
        scope: &str,
        document_id: u64,
        source_ids: &[u64],
        index: i32,
        own_title: &str,
        per_file_bookmarks: bool,
        decision: Option<SignatureDecision>,
    ) -> Result<PdfStructureUpdate, String> {
        if source_ids.is_empty() {
            return Err("no files to add".into());
        }

        if source_ids.len() > MAX_MERGE_FILES {
            return Err(merge_file_limit_error());
        }

        if source_ids.iter().collect::<HashSet<_>>().len() != source_ids.len() {
            return Err("a file can be added only once at a time".into());
        }

        let own_title = sections::section_title(own_title)?;
        let mut signed_paths = Vec::new();
        let flatten = {
            let organize = self.lock_organize();

            for id in source_ids {
                let source = organize.entry(scope, *id)?;

                if source.signed {
                    signed_paths.push(source.path.clone());
                }
            }

            match (!signed_paths.is_empty(), decision) {
                (false, _) => false,
                (true, Some(decision)) => decision == SignatureDecision::Flatten,
                (true, None) => {
                    return Err("an added file's signatures need an answer first".into())
                }
            }
        };
        // Closing the document stops it between files, as any long edit stops.
        let operation = self.begin_operation(OperationTarget::Document(document_id));
        let (slot, before) = {
            let mut documents = self.lock_documents()?;
            let entry = open_entry_mut(&mut documents, document_id)?;
            entry.ensure_editable()?;
            let Some(slot) = page_index(index, entry.page_ids.len() + 1) else {
                return Err(format!("a page cannot go to position {index}"));
            };
            let snapshot = entry
                .document
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not snapshot the document: {error}"))?;
            let before = InsertRollback {
                snapshot,
                page_ids: entry.page_ids.clone(),
                owned_content: entry.owned_content.clone(),
                foreign_page_ids: entry.foreign_page_ids.clone(),
                started_sections: entry.sections.is_none(),
            };

            if entry.sections.is_none() {
                let outline = collect_bookmark_siblings(entry.document.bookmarks().root());

                entry.sections = Some(sections::SectionBook::begin(
                    own_title,
                    &entry.page_ids,
                    &outline,
                    per_file_bookmarks,
                ));
            } else if let Some(book) = entry.sections.as_mut() {
                book.resume(&entry.page_ids, own_title, per_file_bookmarks);
            }

            (slot, before)
        };
        let mut at = slot;
        let mut added = Vec::with_capacity(source_ids.len());

        for id in source_ids {
            let inserted = if operation.is_cancelled() {
                Err("the files were not added: the document closed".to_string())
            } else {
                self.with_organize_source(scope, *id, |documents, source, path| {
                    let entry = open_entry_mut(documents, document_id)?;
                    let count = source.pages().len() as usize;
                    let all: Vec<usize> = (0..count).collect();
                    let flattened = if flatten {
                        Some(signatures::flattened_pages(self.pdfium, source, &all)?)
                    } else {
                        None
                    };

                    entry
                        .document
                        .pages_mut()
                        .copy_pages_from_document(
                            flattened.as_ref().unwrap_or(source),
                            &page_range_argument(&all),
                            at as i32,
                        )
                        .map_err(|error| {
                            format!("PDFium could not add {}: {error}", path.display())
                        })?;
                    Self::record_inserted_pages(entry, at, &vec![false; count])?;

                    let ids = entry.page_ids[at..at + count].to_vec();
                    let title = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .and_then(|name| sections::section_title(&name).ok())
                        .unwrap_or_else(|| path.display().to_string());
                    let outline = collect_bookmark_siblings(source.bookmarks().root());

                    entry
                        .sections
                        .as_mut()
                        .expect("the files began before the first was added")
                        .add(title, &ids, &outline);
                    entry.foreign_page_ids.extend(ids);

                    Ok(count)
                })
            };

            match inserted {
                Ok(count) => {
                    at += count;
                    added.push(*id);
                }
                Err(error) => {
                    let mut documents = self.lock_documents()?;
                    let entry = open_entry_mut(&mut documents, document_id)?;

                    return Err(before.roll_back(self, entry, error));
                }
            }
        }

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let mut organize = self.lock_organize();

        // Their pages are this document's own copies now: an undo's stash, not
        // the source, brings them back.
        for id in added {
            organize.remove(id);
        }

        drop(organize);
        entry.signed_added.extend(signed_paths);
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
    }

    /// A new document of the plan's pages, in its order, with its outline and
    /// any watermark or page numbers stamped on. Like a merge it has no source
    /// path, so it can only ever be exported.
    pub fn assemble_pdf(
        &self,
        scope: &str,
        plan: AssemblePlan,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<Option<PdfDocumentInfo>, String> {
        let AssemblePlan {
            slots,
            normalize_a4,
            outline,
            watermark,
            page_numbers,
            signatures,
        } = plan;

        if slots.is_empty() {
            return Err("an assembly needs at least one page".into());
        }

        if slots.len() > MAX_ASSEMBLE_PAGES {
            return Err(format!(
                "an assembly takes at most {MAX_ASSEMBLE_PAGES} pages"
            ));
        }

        let mut budget = MAX_OUTLINE_ITEMS;
        let nodes = outline_nodes(outline, slots.len(), 0, &mut budget)?;
        let watermark = watermark.map(WatermarkConfig::validated).transpose()?;
        let page_numbers = page_numbers
            .map(|config| config.validated(slots.len() as i32))
            .transpose()?;
        let stamped = watermark.is_some() || page_numbers.is_some();

        // Every slot checked before anything is built: a refusal halfway would
        // have spent the reader's wait on a document that is then thrown away.
        let mut signed_sources = HashSet::new();
        {
            let organize = self.lock_organize();

            for slot in &slots {
                match slot {
                    AssembleSlot::Page {
                        source_id,
                        page_number,
                        turn,
                    } => {
                        let entry = organize.entry(scope, *source_id)?;

                        if entry.signed {
                            signed_sources.insert(*source_id);
                        }

                        if page_index(*page_number, entry.page_count).is_none() {
                            return Err(format!("page {page_number} does not exist"));
                        }

                        quarter_turn(*turn)?;
                    }
                    AssembleSlot::Blank { width, height } => {
                        if !valid_side(*width) || !valid_side(*height) {
                            return Err(format!(
                                "a blank page must be between {MIN_PAGE_SIDE} and {MAX_PAGE_SIDE} points a side"
                            ));
                        }
                    }
                }
            }
        }

        if !signed_sources.is_empty() && signatures.is_none() {
            return Err(signatures::SIGNATURES_UNDECIDED_ERROR.into());
        }

        let flatten = signatures == Some(SignatureDecision::Flatten);

        if !flatten {
            signed_sources.clear();
        }

        // Cut before the build, as the slots are checked: a mark no installed
        // face can draw refuses now, not after the reader has waited for it.
        let watermark = watermark
            .map(|config| self.watermark_resources(&config))
            .transpose()?;
        let page_numbers = page_numbers
            .map(|config| self.page_numbers_resources(&config))
            .transpose()?;

        let groups = slots_by_source(&slots);
        // One unit per source imported, or per page fitted, then one each for
        // the blanks, serialization, outline, and opening, then the two passes
        // a layer rebuild reports per page.
        let units = if normalize_a4 {
            groups.iter().map(|(_, pages)| pages.len()).sum()
        } else {
            groups.len()
        };
        let layer_units = if stamped { slots.len() * 2 } else { 0 };
        let total = units + 4 + layer_units;

        on_progress(0, total);

        let mut completed = 0;
        let mut step = || {
            completed += 1;
            on_progress(completed, total);
        };
        let operation = self.begin_operation(OperationTarget::Merge(scope.to_string()));
        let mut draft = MergeDraft::new(self)?;
        let mut draft_index = vec![0; slots.len()];
        let built = if normalize_a4 {
            // Each source with whether its pages' signatures go in first.
            let groups: Vec<_> = groups
                .iter()
                .map(|group| (group.clone(), signed_sources.contains(&group.0)))
                .collect();

            self.fit_sources(
                scope,
                &groups,
                &mut draft,
                &operation,
                &mut draft_index,
                &mut step,
            )?
        } else {
            self.import_sources(
                scope,
                &groups,
                &mut draft,
                &operation,
                &mut draft_index,
                &mut step,
            )?
        };

        if !built {
            return Ok(None);
        }

        self.append_blanks(&slots, normalize_a4, &mut draft, &mut draft_index)?;
        step();

        // Turned before the permutation, page by page in draft order, so no
        // page is held across the raw move below; each takes the lock alone,
        // so a render waits for one page, not every turned one.
        for (slot, &index) in slots.iter().zip(&draft_index) {
            let AssembleSlot::Page { turn, .. } = slot else {
                continue;
            };
            let turn = quarter_turn(*turn)?;

            if turn == 0 {
                continue;
            }

            if operation.is_cancelled() {
                return Ok(None);
            }

            let _documents = self.lock_documents()?;
            let mut page =
                draft.document().pages_mut().get(index).map_err(|error| {
                    format!("PDFium could not load page {}: {error}", index + 1)
                })?;
            let rotation = quarter_turn_rotation(page_rotation_degrees(&page) as i32 + turn);

            page.set_rotation(rotation);
        }

        if operation.is_cancelled() {
            return Ok(None);
        }

        let in_order = draft_index
            .iter()
            .enumerate()
            .all(|(position, &index)| position as PdfPageIndex == index);
        let bytes = {
            let _documents = self.lock_documents()?;
            let document = draft.document();

            if !in_order {
                move_pages(document, &draft_index)?;
            }

            let bytes = document
                .save_to_bytes()
                .map_err(|error| format!("PDFium could not build the document: {error}"))?;

            draft.close();
            bytes
        };
        step();

        if operation.is_cancelled() {
            return Ok(None);
        }

        // Byte work, not PDFium work, so the lock is given back for it. Every
        // signature widget an imported page brought along is drawn in; a
        // fitted page had its own drawn in at its source, and brought none.
        let bytes = if flatten && !normalize_a4 {
            signatures::flattened_bytes(bytes)?
        } else {
            bytes
        };
        let bytes = outline::write_outline(bytes, &nodes)?;
        step();

        if operation.is_cancelled() {
            return Ok(None);
        }

        let document = self.open_with_source(bytes, None)?;
        step();

        if !stamped {
            return Ok(Some(document));
        }

        let opened = completed;
        let outcome = self.stamp_layers(
            document.id,
            watermark,
            page_numbers,
            &mut |done, _| on_progress(opened + done, total),
            &operation,
        );

        // Handed back only whole: a stopped or failed stamp leaves nothing in
        // the store for the reader to close.
        match outcome {
            Ok(true) => Ok(Some(document)),
            Ok(false) => self.close(document.id).map(|()| None),
            Err(error) => {
                self.close(document.id).ok();
                Err(error)
            }
        }
    }

    /// One import per source, all its pages at once: PDFium shares a font or
    /// image between the pages of one import, but copies it again per call.
    /// `false` once stopped.
    fn import_sources(
        &self,
        scope: &str,
        groups: &[SourcePages],
        draft: &mut MergeDraft<'_>,
        operation: &OperationGuard<'_>,
        draft_index: &mut [PdfPageIndex],
        progress: &mut impl FnMut(),
    ) -> Result<bool, String> {
        for (source_id, pages) in groups {
            if operation.is_cancelled() {
                return Ok(false);
            }

            let indices: Vec<i32> = pages
                .iter()
                .map(|&(_, page_number)| page_number - 1)
                .collect();

            self.with_organize_source(scope, *source_id, |_, source, path| {
                let document = draft.document();
                let bindings = document.bindings();
                let start = document.pages().len();
                // SAFETY: both handles live for these borrows, the engine
                // serializes PDFium calls, and the pages land at the end, past
                // every index pdfium-render's page cache may already hold.
                let imported = unsafe {
                    bindings.FPDF_ImportPagesByIndex_vec(
                        bindings.get_handle_from_document(document),
                        bindings.get_handle_from_document(source),
                        indices,
                        start,
                    )
                };

                if !bindings.is_true(imported) {
                    return Err(format!("PDFium could not copy pages of {}", path.display()));
                }

                for (offset, &(position, _)) in pages.iter().enumerate() {
                    draft_index[position] = start + offset as PdfPageIndex;
                }

                Ok(())
            })?;
            progress();
        }

        Ok(true)
    }

    /// Page by page onto A4 sheets, each sized and placed on its own terms
    /// under a hold of the lock of its own. A source at a time, however the
    /// plan interleaves them: in plan order, two files over the budget
    /// together would each be read again from disk for every page.
    /// `false` once stopped.
    fn fit_sources(
        &self,
        scope: &str,
        groups: &[(SourcePages, bool)],
        draft: &mut MergeDraft<'_>,
        operation: &OperationGuard<'_>,
        draft_index: &mut [PdfPageIndex],
        progress: &mut impl FnMut(),
    ) -> Result<bool, String> {
        for ((source_id, pages), flatten) in groups {
            for &(position, page_number) in pages {
                if operation.is_cancelled() {
                    return Ok(false);
                }

                self.with_organize_source(scope, *source_id, |_, source, path| {
                    let document = draft.document();

                    draft_index[position] = document.pages().len();

                    // A form XObject leaves annotations behind, so the page's
                    // signatures go into its content first, on a copy of it.
                    if *flatten && signatures::has_widgets(source, page_number - 1)? {
                        let page = signatures::flattened_pages(
                            self.pdfium,
                            source,
                            &[(page_number - 1) as usize],
                        )?;

                        return append_page_fitted_to_a4(document, &page, 0, path);
                    }

                    append_page_fitted_to_a4(document, source, page_number - 1, path)
                })?;
                progress();
            }
        }

        Ok(true)
    }

    /// After every source's pages, sized as planned — or, on A4, a bare sheet
    /// turned the way the planned size is.
    fn append_blanks(
        &self,
        slots: &[AssembleSlot],
        normalize_a4: bool,
        draft: &mut MergeDraft<'_>,
        draft_index: &mut [PdfPageIndex],
    ) -> Result<(), String> {
        let _documents = self.lock_documents()?;
        let document = draft.document();

        for (position, slot) in slots.iter().enumerate() {
            let AssembleSlot::Blank { width, height } = *slot else {
                continue;
            };
            let (width, height) = if !normalize_a4 {
                (width, height)
            } else if width > height {
                (A4_LONG_POINTS, A4_SHORT_POINTS)
            } else {
                (A4_SHORT_POINTS, A4_LONG_POINTS)
            };

            draft_index[position] = document.pages().len();

            let page = document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::Custom(
                    PdfPoints::new(width),
                    PdfPoints::new(height),
                ))
                .map_err(|error| format!("PDFium could not create a blank page: {error}"))?;

            drop(page);
        }

        Ok(())
    }
}

/// The document as an insert of files found it, put back whole if one of them
/// cannot be added: the bytes, and every page-keyed record the files touched.
struct InsertRollback {
    snapshot: Vec<u8>,
    page_ids: Vec<u64>,
    owned_content: Option<OwnedContentState>,
    foreign_page_ids: HashSet<u64>,
    /// The first file added began the document's files, which go again.
    started_sections: bool,
}

impl InsertRollback {
    fn roll_back(self, engine: &PdfiumEngine, entry: &mut OpenDocument, cause: String) -> String {
        entry.page_ids = self.page_ids;
        entry.owned_content = self.owned_content;
        entry.foreign_page_ids = self.foreign_page_ids;

        if self.started_sections {
            entry.sections = None;
        }

        engine.restore_document_snapshot(entry, self.snapshot, cause)
    }
}
