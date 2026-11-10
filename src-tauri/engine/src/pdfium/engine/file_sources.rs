//! Files read for the pages a document adds: never edited, only copied into
//! the document by `insert_sources`, and let go once their pages are in.

use serde::Serialize;

use super::io::{
    fingerprint, is_merge_image, load_merge_source, merge_file_limit_error, read_merge_source,
    Fingerprint, SourceFile, MAX_MERGE_FILES,
};
use super::page_ops::{page_index, page_range_argument};
use super::*;

/// Bytes of sources kept parsed at once, every window's together; the rest
/// are read again from disk when an insert next needs them.
const OPEN_SOURCE_BUDGET: usize = 512 * 1024 * 1024;

/// Why an insert refuses a source whose file is no longer what was read.
pub const SOURCE_CHANGED: &str = "the file changed since it was added";

struct FileSource {
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
pub(super) struct FileSources {
    entries: HashMap<u64, FileSource>,
    /// Least recently used first.
    open: Vec<OpenSource>,
}

impl FileSources {
    pub(super) fn is_signed_source(&self, path: &Path) -> bool {
        self.entries
            .values()
            .any(|source| source.signed && same_file(&source.path, path))
    }

    fn entry(&self, scope: &str, id: u64) -> Result<&FileSource, String> {
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
    /// is still one the reader can add.
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

/// What the frontend learns of a file it reads; `id` is absent where the file
/// could not be read, and `error` then says why where "unreadable" would not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceInfo {
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

impl PdfiumEngine {
    pub(super) fn lock_sources(&self) -> MutexGuard<'_, FileSources> {
        // Bookkeeping like the operations list: a poisoned lock must not leave
        // every later source unreadable.
        self.sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads each file just far enough to show its pages, keeping it parsed
    /// while the budget allows. An unreadable file is reported, not dropped.
    pub fn read_sources(
        &self,
        scope: &str,
        paths: Vec<PathBuf>,
        word_conversion: bool,
    ) -> Result<Vec<FileSourceInfo>, String> {
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
            .map_while(|(path, word)| self.read_source(scope, path, word, &cancelled))
            .collect())
    }

    /// `None` once the scope's work is stopped, keeping nothing.
    fn read_source(
        &self,
        scope: &str,
        path: PathBuf,
        word: crate::convert::Entry,
        cancelled: &dyn Fn() -> bool,
    ) -> Option<FileSourceInfo> {
        let kind = match word {
            crate::convert::Entry::NotWord if is_merge_image(&path) => MergeSourceKind::Image,
            crate::convert::Entry::NotWord => MergeSourceKind::Pdf,
            _ => MergeSourceKind::Word,
        };
        let refused = |error: Option<MergeSourceError>| {
            Some(FileSourceInfo {
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

        let mut sources = self.lock_sources();
        let id = self.next_source_id.fetch_add(1, Ordering::Relaxed);

        sources.entries.insert(
            id,
            FileSource {
                scope: scope.to_string(),
                path: path.clone(),
                read_from,
                fingerprint,
                page_count: layout.num_pages as usize,
                signed: false,
            },
        );
        sources.keep_open(id, document, cost);
        drop(sources);
        drop(documents);

        let signed = scan.as_ref().is_some_and(|scan| {
            scan.intact_in(&signatures::OpenedFile {
                path: path.clone(),
                fingerprint,
            })
        });

        if signed {
            if let Some(source) = self.lock_sources().entries.get_mut(&id) {
                source.signed = true;
            }
        }

        Some(FileSourceInfo {
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
    fn with_source<T>(
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
            let mut sources = self.lock_sources();
            let entry = sources.entry(scope, id)?;
            let facts = (
                entry.path.clone(),
                entry.read_from.clone(),
                entry.fingerprint,
                entry.page_count,
            );

            if let Some(document) = sources.touch(id) {
                return work(&mut documents, document, &facts.0);
            }

            facts
        };

        // Its pages are what the reader was shown: a file that has changed
        // since, or gone, may have others, or fewer.
        if fingerprint(&path) != Some(recorded) {
            return Err(SOURCE_CHANGED.into());
        }

        let file = read_merge_source(&read_from)?;
        let cost = source_cost(&file);
        let mut documents = self.lock_documents()?;
        let mut sources = self.lock_sources();

        // Released, or read back by another call, while this one read the disk.
        sources.entry(scope, id)?;

        if sources.touch(id).is_none() {
            let document = load_merge_source(self.pdfium, file, &read_from)?;

            if document.pages().len() as usize != page_count {
                return Err(SOURCE_CHANGED.into());
            }

            sources.keep_open(id, document, cost);
        }

        let document = sources.touch(id).expect("the source was just kept open");

        work(&mut documents, document, &path)
    }

    /// Lets every parsed source go, as the budget would, so the next use reads
    /// the disk again.
    #[cfg(test)]
    pub(super) fn evict_sources_for_test(&self, scope: &str) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut sources = self.lock_sources();
        let ids = sources.ids_in(scope);

        sources.open.retain(|open| !ids.contains(&open.id));
    }

    /// Lets go of sources read for a document they never reached: a prompt
    /// declined, an insert refused. Another window's ids are passed over.
    pub fn release_sources(&self, scope: &str, ids: &[u64]) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut sources = self.lock_sources();

        for id in ids {
            if sources.entry(scope, *id).is_ok() {
                sources.remove(*id);
            }
        }
    }

    /// Where a release taken now must stop: read without a lock, so a window
    /// event can take it while an insert holds every PDFium lock.
    pub fn source_release_cutoff(&self) -> u64 {
        self.next_source_id.load(Ordering::Relaxed)
    }

    /// A window's sources have nowhere to be shown once it is gone. Stop the
    /// scope's work first (`cancel_scope_work`), so an add still running
    /// keeps nothing after this. Only ids below `before` go: a release that
    /// waited for the lock must spare what the reloaded page has added since.
    pub fn release_source_scope(&self, scope: &str, before: u64) {
        let Ok(_documents) = self.lock_documents() else {
            return;
        };
        let mut sources = self.lock_sources();
        let ids = sources.ids_in(scope);

        for id in ids.into_iter().filter(|id| *id < before) {
            sources.remove(id);
        }
    }

    /// Adds files `read_sources` read to an open document, all before
    /// 1-based `index`, each a file of its own and in order; the sources go
    /// once their pages are in. One step: the caller's undo deletes the whole
    /// run under its stash. A signed source needs `decision`, which a new file
    /// would ask for: its signatures cannot hold in this document either.
    /// `own_title` names the document's own pages, should this be the first
    /// file added, and `options` how its files are laid out and saved.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_sources(
        &self,
        scope: &str,
        document_id: u64,
        source_ids: &[u64],
        index: i32,
        own_title: &str,
        options: sections::FileOptions,
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
            let sources = self.lock_sources();

            for id in source_ids {
                let source = sources.entry(scope, *id)?;

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
                    options,
                ));
            } else if let Some(book) = entry.sections.as_mut() {
                book.resume(&entry.page_ids, own_title, options);
            }

            (slot, before)
        };
        let mut at = slot;
        let mut added = Vec::with_capacity(source_ids.len());

        for id in source_ids {
            let inserted = if operation.is_cancelled() {
                Err("the files were not added: the document closed".to_string())
            } else {
                self.with_source(scope, *id, |documents, source, path| {
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
        let mut sources = self.lock_sources();

        // Their pages are this document's own copies now: an undo's stash, not
        // the source, brings them back.
        for id in added {
            sources.remove(id);
        }

        drop(sources);
        entry.signed_added.extend(signed_paths);
        entry.invalidate_all_page_revisions();

        Ok(structure_update(entry))
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
