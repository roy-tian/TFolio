//! A document's pages by the file each came in with: what the sidebar groups
//! under file names, and what a Save As writes as one bookmark per file.
//! Absent until a file is added; a document opened alone has one file.

use serde::{Deserialize, Serialize};

use super::*;

/// The longest a file's name may grow by a rename; a bookmark title past this
/// is a payload, and `write_outline` would cut it anyway.
const MAX_SECTION_TITLE_CHARS: usize = 512;

pub(super) struct SectionBook {
    sections: Vec<Section>,
    /// Kept for pages a delete took out, so an undo's restore brings each back
    /// into the file it left, with no record of its own in the stash.
    page_section: HashMap<u64, u64>,
    next_id: u64,
    pub(super) options: FileOptions,
}

/// How a document of several files is laid out and saved: a blank page
/// closing a file that would leave the next to start on an even page, and one
/// bookmark per file above its own rather than the files' own one after
/// another. The reader's choices, undoable, kept with the document.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOptions {
    pub smart_padding: bool,
    pub per_file_bookmarks: bool,
}

struct Section {
    id: u64,
    title: String,
    outline: Vec<SectionBookmark>,
}

/// A file's bookmark, aimed at a page by its stable id, so it follows that
/// page wherever a reorder takes it; a page deleted leaves it pointing nowhere.
#[derive(Clone)]
struct SectionBookmark {
    title: String,
    page_id: Option<u64>,
    children: Vec<SectionBookmark>,
}

/// A blank page a Save As will add, after 1-based page `after`, as large as
/// that page shows.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPaddingSheet {
    pub(super) after: usize,
    pub(super) width: f32,
    pub(super) height: f32,
}

/// One file of a document, as the sidebar's tree shows it: bookmarks numbered
/// for the pages as they now stand.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSection {
    pub(super) id: u64,
    pub(super) title: String,
    pub(super) outline: Vec<PdfOutlineItem>,
}

/// A file's bookmarks as a source document numbers them, aimed at the ids its
/// pages took in this one.
fn bookmarks_from(items: &[PdfOutlineItem], page_ids: &[u64]) -> Vec<SectionBookmark> {
    items
        .iter()
        .map(|item| SectionBookmark {
            title: item.title.clone(),
            page_id: item
                .page_number
                .and_then(|number| page_index(number, page_ids.len()))
                .map(|index| page_ids[index]),
            children: bookmarks_from(&item.items, page_ids),
        })
        .collect()
}

fn numbered(items: &[SectionBookmark], position: &HashMap<u64, usize>) -> Vec<PdfOutlineItem> {
    items
        .iter()
        .map(|item| PdfOutlineItem {
            title: item.title.clone(),
            page_number: item
                .page_id
                .and_then(|id| position.get(&id))
                .map(|index| *index as i32 + 1),
            items: numbered(&item.children, position),
        })
        .collect()
}

/// A bookmark whose page is gone gives way to its children, as an assembly's
/// outline drops one; 0-based pages.
fn outline_nodes(items: &[SectionBookmark], position: &HashMap<u64, usize>) -> Vec<OutlineNode> {
    items
        .iter()
        .flat_map(|item| {
            let children = outline_nodes(&item.children, position);

            match item.page_id.and_then(|id| position.get(&id)) {
                Some(&page) => vec![OutlineNode {
                    title: item.title.clone(),
                    page,
                    children,
                }],
                None => children,
            }
        })
        .collect()
}

/// A file's name as the reader may give it: trimmed, never empty, never long.
pub(super) fn section_title(title: &str) -> Result<String, String> {
    let title = title.trim();

    if title.is_empty() {
        return Err("a file needs a name".into());
    }

    if title.chars().count() > MAX_SECTION_TITLE_CHARS {
        return Err(format!(
            "a file's name holds at most {MAX_SECTION_TITLE_CHARS} characters"
        ));
    }

    Ok(title.to_string())
}

impl SectionBook {
    /// The document as it stood alone, before its first added file: every page
    /// in one section, its own bookmarks aimed at the pages they name now.
    pub(super) fn begin(
        title: String,
        page_ids: &[u64],
        outline: &[PdfOutlineItem],
        options: FileOptions,
    ) -> Self {
        Self {
            sections: vec![Section {
                id: 0,
                title,
                outline: bookmarks_from(outline, page_ids),
            }],
            page_section: page_ids.iter().map(|id| (*id, 0)).collect(),
            next_id: 1,
            options,
        }
    }

    /// A file added as pages `page_ids`, its bookmarks as it numbers them.
    pub(super) fn add(
        &mut self,
        title: String,
        page_ids: &[u64],
        outline: &[PdfOutlineItem],
    ) -> u64 {
        let id = self.next_id;

        self.next_id += 1;
        self.sections.push(Section {
            id,
            title,
            outline: bookmarks_from(outline, page_ids),
        });
        self.page_section
            .extend(page_ids.iter().map(|page_id| (*page_id, id)));

        id
    }

    /// A document back to one file — an undo took the added ones out — goes
    /// by the name it has now, which a Save As since may have changed, and
    /// lays out and saves its files as the reader chooses now.
    pub(super) fn resume(&mut self, page_ids: &[u64], title: String, options: FileOptions) {
        if self.several(page_ids) {
            return;
        }

        let alone: Vec<u64> = self
            .shown(page_ids)
            .iter()
            .map(|section| section.id)
            .collect();

        for id in alone {
            let _ = self.rename(id, title.clone());
        }

        self.options = options;
    }

    pub(super) fn contains(&self, section_id: u64) -> bool {
        self.sections.iter().any(|section| section.id == section_id)
    }

    pub(super) fn section_of(&self, page_id: u64) -> Option<u64> {
        self.page_section.get(&page_id).copied()
    }

    /// New pages join `section`, checked by the caller, or else the file of
    /// the page before them — of the one after, at the very start. `slot` is
    /// where the first of `new` stands in `page_ids`.
    fn assign(&mut self, page_ids: &[u64], new: &[u64], slot: usize, section: Option<u64>) {
        let section = section
            .or_else(|| {
                slot.checked_sub(1)
                    .and_then(|before| page_ids.get(before))
                    .or_else(|| page_ids.get(slot + new.len()))
                    .and_then(|page_id| self.section_of(*page_id))
            })
            .unwrap_or(0);

        self.page_section
            .extend(new.iter().map(|page_id| (*page_id, section)));
    }

    fn check_layout(&self, page_count: usize, sections: &[u64]) -> Result<(), String> {
        if sections.len() != page_count {
            return Err(format!(
                "a layout of {} files does not fit {page_count} pages",
                sections.len()
            ));
        }

        match sections.iter().find(|id| !self.contains(**id)) {
            Some(unknown) => Err(format!("file {unknown} is not one of this document's")),
            None => Ok(()),
        }
    }

    /// Every page's file, position by position, as a reorder lands them: a page
    /// dropped among another file's joins it. Checked by `check_layout` first.
    pub(super) fn set_layout(&mut self, page_ids: &[u64], sections: &[u64]) {
        self.page_section
            .extend(page_ids.iter().copied().zip(sections.iter().copied()));
    }

    pub(super) fn rename(&mut self, section_id: u64, title: String) -> Result<(), String> {
        self.sections
            .iter_mut()
            .find(|section| section.id == section_id)
            .map(|section| section.title = title)
            .ok_or_else(|| format!("file {section_id} is not one of this document's"))
    }

    /// The files with a page still in the document, by where each first stands.
    fn shown(&self, page_ids: &[u64]) -> Vec<&Section> {
        let mut seen = Vec::new();

        for page_id in page_ids {
            if let Some(id) = self.section_of(*page_id) {
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
        }

        seen.iter()
            .filter_map(|id| self.sections.iter().find(|section| section.id == *id))
            .collect()
    }

    /// Whether the pages still come from more than one file: only then do
    /// they show as files, and a Save As write one bookmark each.
    pub(super) fn several(&self, page_ids: &[u64]) -> bool {
        self.shown(page_ids).len() > 1
    }

    pub(super) fn infos(&self, page_ids: &[u64]) -> Vec<PdfSection> {
        let position = positions(page_ids);

        self.shown(page_ids)
            .into_iter()
            .map(|section| PdfSection {
                id: section.id,
                title: section.title.clone(),
                outline: numbered(&section.outline, &position),
            })
            .collect()
    }

    /// Where a Save As puts its blank pages, by the index of the page each
    /// follows: before a file that would otherwise start on an even page, as
    /// the back of the last leaf of the file before it.
    pub(super) fn padding(&self, page_ids: &[u64]) -> Vec<usize> {
        if !self.options.smart_padding || !self.several(page_ids) {
            return Vec::new();
        }

        let mut after = Vec::new();
        let mut written = 0usize;
        let mut previous = None;

        for (index, page_id) in page_ids.iter().enumerate() {
            let section = self.section_of(*page_id);

            if index > 0 && section != previous && written % 2 == 1 {
                after.push(index - 1);
                written += 1;
            }

            previous = section;
            written += 1;
        }

        after
    }

    /// The outline a Save As writes: a bookmark per run of a file's pages with
    /// the file's own beneath its first, or the files' own one after another,
    /// its pages counted with `padding`'s blank pages in among them.
    pub(super) fn outline(&self, page_ids: &[u64], padding: &[usize]) -> Vec<OutlineNode> {
        let landed = |index: usize| index + padding.iter().filter(|after| **after < index).count();
        let position: HashMap<u64, usize> = page_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, landed(index)))
            .collect();
        let mut nodes = Vec::new();
        let mut written = HashSet::new();
        let mut previous = None;

        for (index, page_id) in page_ids.iter().enumerate() {
            let Some(id) = self.section_of(*page_id) else {
                continue;
            };

            if previous == Some(id) {
                continue;
            }

            previous = Some(id);

            let Some(section) = self.sections.iter().find(|section| section.id == id) else {
                continue;
            };
            let own = if written.insert(id) {
                outline_nodes(&section.outline, &position)
            } else {
                Vec::new()
            };

            if self.options.per_file_bookmarks {
                nodes.push(OutlineNode {
                    title: section.title.clone(),
                    page: landed(index),
                    children: own,
                });
            } else {
                nodes.extend(own);
            }
        }

        nodes
    }
}

fn positions(page_ids: &[u64]) -> HashMap<u64, usize> {
    page_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect()
}

impl PdfiumEngine {
    /// The document's own record of how its files are laid out and saved.
    pub fn set_file_options(
        &self,
        document_id: u64,
        options: FileOptions,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;

        entry
            .sections
            .as_mut()
            .ok_or("this document has no files to lay out")?
            .options = options;

        Ok(structure_update(entry))
    }

    /// Gives a file of the document a new name: the one its bookmark takes in a
    /// Save As. Changes no page, so no signature decision is asked for.
    pub fn rename_section(
        &self,
        document_id: u64,
        section_id: u64,
        title: &str,
    ) -> Result<PdfStructureUpdate, String> {
        let title = section_title(title)?;
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        let book = entry
            .sections
            .as_mut()
            .ok_or("this document has no files to name")?;

        book.rename(section_id, title)?;

        Ok(structure_update(entry))
    }
}

impl OpenDocument {
    /// Another file's pages are here, or the pages still show as more than one
    /// file: the document is no longer its file alone, so only a Save As may
    /// write it, as the files, blanks and bookmarks the reader sees.
    pub(super) fn combined(&self) -> bool {
        !self.foreign_page_ids.is_empty()
            || self
                .sections
                .as_ref()
                .is_some_and(|book| book.several(&self.page_ids))
    }

    /// The blank pages a Save As will add, each after the 1-based page it
    /// follows and sized as that page shows; what the viewer and print show.
    pub(super) fn padding_sheets(&self) -> Vec<PdfPaddingSheet> {
        let Some(book) = &self.sections else {
            return Vec::new();
        };

        book.padding(&self.page_ids)
            .into_iter()
            .map(|after| {
                let page = self
                    .page_ids
                    .get(after)
                    .and_then(|page_id| self.page_geometry.get(page_id))
                    .copied()
                    .unwrap_or(UNMEASURED_PAGE);

                PdfPaddingSheet {
                    after: after + 1,
                    width: page.width,
                    height: page.height,
                }
            })
            .collect()
    }

    /// Refuses a file the document does not have before any page moves.
    pub(super) fn check_section(&self, section: Option<u64>) -> Result<(), String> {
        match (section, &self.sections) {
            (None, _) => Ok(()),
            (Some(id), Some(book)) if book.contains(id) => Ok(()),
            (Some(id), _) => Err(format!("file {id} is not one of this document's")),
        }
    }

    /// Refuses a layout that does not fit before any page moves.
    pub(super) fn check_layout(&self, layout: Option<&[u64]>) -> Result<(), String> {
        let Some(layout) = layout else {
            return Ok(());
        };
        let book = self
            .sections
            .as_ref()
            .ok_or("this document has no files to lay its pages out by")?;

        book.check_layout(self.page_ids.len(), layout)
    }

    /// The `count` pages just inserted at `slot` join `section`, or the file
    /// beside them, once the document has files at all.
    pub(super) fn sections_inserted(&mut self, slot: usize, count: usize, section: Option<u64>) {
        if let Some(book) = self.sections.as_mut() {
            let new = &self.page_ids[slot..slot + count];

            book.assign(&self.page_ids, new, slot, section);
        }
    }
}
