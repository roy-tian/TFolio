//! In-memory bookmark edits and undo stashes for single-file documents and
//! their synchronization with multi-file `SectionBook` section 0.

use super::outline::{validate_exact_title, validate_title, EditableOutlineItem};
use super::sections::SectionBookmark;
use super::*;

pub(super) struct BookmarkStash {
    section_id: Option<u64>,
    path: Vec<usize>,
    own: Option<EditableOutlineItem>,
    section: Option<SectionBookmark>,
}

fn editable_from(items: &[PdfOutlineItem], prefix: &mut Vec<usize>) -> Vec<EditableOutlineItem> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            prefix.push(index);
            let origin = prefix.clone();
            let children = editable_from(&item.items, prefix);
            prefix.pop();

            EditableOutlineItem {
                origin,
                title: item.title.clone(),
                children,
            }
        })
        .collect()
}

fn lookup_page_number(items: &[PdfOutlineItem], origin: &[usize]) -> Option<i32> {
    let mut current = items;
    let mut found = None;

    for &index in origin {
        found = current.get(index);
        current = found.map_or(&[], |item| item.items.as_slice());
    }

    found.and_then(|item| item.page_number)
}

fn resolve_edited(edits: &[EditableOutlineItem], live: &[PdfOutlineItem]) -> Vec<PdfOutlineItem> {
    edits
        .iter()
        .map(|item| PdfOutlineItem {
            title: item.title.clone(),
            page_number: lookup_page_number(live, &item.origin),
            items: resolve_edited(&item.children, live),
        })
        .collect()
}

fn editable_parent_mut<'a>(
    mut items: &'a mut Vec<EditableOutlineItem>,
    path: &[usize],
) -> Result<(&'a mut Vec<EditableOutlineItem>, usize), String> {
    let Some((&last, ancestors)) = path.split_last() else {
        return Err("bookmark path cannot be empty".into());
    };

    for &index in ancestors {
        items = &mut items
            .get_mut(index)
            .ok_or_else(|| "bookmark does not exist".to_string())?
            .children;
    }

    if last >= items.len() {
        return Err("bookmark does not exist".into());
    }

    Ok((items, last))
}

fn editable_insert_parent_mut<'a>(
    mut items: &'a mut Vec<EditableOutlineItem>,
    path: &[usize],
) -> Result<(&'a mut Vec<EditableOutlineItem>, usize), String> {
    let Some((&last, ancestors)) = path.split_last() else {
        return Err("bookmark path cannot be empty".into());
    };

    for &index in ancestors {
        items = &mut items
            .get_mut(index)
            .ok_or_else(|| "the parent bookmark no longer exists".to_string())?
            .children;
    }

    if last > items.len() {
        return Err("the bookmark position is out of range".into());
    }

    Ok((items, last))
}

impl OpenDocument {
    /// The document's own bookmarks as they currently stand, combining any
    /// in-memory renames/deletions with PDFium's live page destinations.
    pub(super) fn effective_own_outline(&self) -> Vec<PdfOutlineItem> {
        let live = collect_bookmark_siblings(self.document.bookmarks().root());

        match &self.outline_edits {
            Some(edits) => resolve_edited(edits, &live),
            None => live,
        }
    }

    /// Validates and applies a bookmark edit against `outline_edits` (or a
    /// temporary copy of PDFium's outline on the first edit), leaving
    /// `outline_edits` unchanged (`None` if uninitialized) when `mutate` fails.
    fn mutate_outline_edits<T>(
        &mut self,
        mutate: impl FnOnce(&mut Vec<EditableOutlineItem>) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(edits) = self.outline_edits.as_mut() {
            return mutate(edits);
        }

        let live = collect_bookmark_siblings(self.document.bookmarks().root());
        let mut draft = editable_from(&live, &mut Vec::new());
        let result = mutate(&mut draft)?;
        self.outline_edits = Some(draft);
        Ok(result)
    }
}

impl PdfiumEngine {
    pub fn rename_bookmark(
        &self,
        document_id: u64,
        section_id: Option<u64>,
        path: &[usize],
        title: &str,
        exact: bool,
    ) -> Result<PdfStructureUpdate, String> {
        if path.is_empty() {
            return Err("bookmark path cannot be empty".into());
        }

        let title = if exact {
            validate_exact_title(title)?
        } else {
            validate_title(title)?
        };
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        if let Some(id) = section_id {
            let book = entry
                .sections
                .as_ref()
                .filter(|book| book.contains(id))
                .ok_or_else(|| format!("file {id} is not one of this document's"))?;
            let _ = book;

            if id != 0 {
                entry
                    .sections
                    .as_mut()
                    .expect("checked above")
                    .rename_bookmark(id, path, title)?;
                entry.content_changed();
                return Ok(structure_update(entry));
            }
        }

        entry.mutate_outline_edits(|edits| {
            let (parent, index) = editable_parent_mut(edits, path)?;
            parent[index].title = title.clone();
            Ok(())
        })?;

        if let Some(book) = entry.sections.as_mut().filter(|book| book.contains(0)) {
            let _ = book.rename_bookmark(0, path, title);
        }

        entry.content_changed();
        Ok(structure_update(entry))
    }

    pub fn delete_bookmark(
        &self,
        document_id: u64,
        section_id: Option<u64>,
        path: &[usize],
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        if path.is_empty() {
            return Err("bookmark path cannot be empty".into());
        }

        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        if let Some(id) = section_id {
            if !entry
                .sections
                .as_ref()
                .is_some_and(|book| book.contains(id))
            {
                return Err(format!("file {id} is not one of this document's"));
            }

            if id != 0 {
                let removed = entry
                    .sections
                    .as_mut()
                    .expect("checked above")
                    .delete_bookmark(id, path)?;
                entry.bookmark_stashes.insert(
                    stash_id,
                    BookmarkStash {
                        section_id: Some(id),
                        path: path.to_vec(),
                        own: None,
                        section: Some(removed),
                    },
                );
                entry.content_changed();
                return Ok(structure_update(entry));
            }
        }

        let own_removed = entry.mutate_outline_edits(|edits| {
            let (parent, index) = editable_parent_mut(edits, path)?;
            Ok(parent.remove(index))
        })?;
        let section_removed = entry
            .sections
            .as_mut()
            .filter(|book| book.contains(0))
            .and_then(|book| book.delete_bookmark(0, path).ok());

        entry.bookmark_stashes.insert(
            stash_id,
            BookmarkStash {
                section_id,
                path: path.to_vec(),
                own: Some(own_removed),
                section: section_removed,
            },
        );
        entry.content_changed();
        Ok(structure_update(entry))
    }

    pub fn restore_bookmark(
        &self,
        document_id: u64,
        stash_id: u64,
    ) -> Result<PdfStructureUpdate, String> {
        let mut documents = self.lock_documents()?;
        let entry = open_entry_mut(&mut documents, document_id)?;
        entry.ensure_editable()?;

        let Some(stash) = entry.bookmark_stashes.remove(&stash_id) else {
            return Err("there is no stashed bookmark under this undo entry".into());
        };

        if let Some(id) = stash.section_id {
            if id != 0 {
                let result = match (entry.sections.as_mut(), stash.section.clone()) {
                    (Some(book), Some(item)) => book.restore_bookmark(id, &stash.path, item),
                    _ => Err(format!("file {id} is not one of this document's")),
                };
                if let Err(error) = result {
                    entry.bookmark_stashes.insert(stash_id, stash);
                    return Err(error);
                }
                entry.content_changed();
                return Ok(structure_update(entry));
            }
        }

        let Some(own_item) = stash.own.clone() else {
            entry.bookmark_stashes.insert(stash_id, stash);
            return Err("there is no stashed bookmark to restore".into());
        };

        if let Err(error) = entry.mutate_outline_edits(|edits| {
            let (parent, index) = editable_insert_parent_mut(edits, &stash.path)?;
            parent.insert(index, own_item);
            Ok(())
        }) {
            entry.bookmark_stashes.insert(stash_id, stash);
            return Err(error);
        }

        if entry.sections.as_ref().is_some_and(|book| book.contains(0)) {
            if let Some(section_item) = stash.section {
                let restored = entry
                    .sections
                    .as_mut()
                    .expect("checked above")
                    .restore_bookmark(0, &stash.path, section_item);
                if restored.is_err() {
                    let own = entry.effective_own_outline();
                    let page_ids = entry.page_ids.clone();
                    if let Some(book) = entry.sections.as_mut() {
                        book.replace_outline(0, &own, &page_ids);
                    }
                }
            } else {
                let own = entry.effective_own_outline();
                let page_ids = entry.page_ids.clone();
                if let Some(book) = entry.sections.as_mut() {
                    book.replace_outline(0, &own, &page_ids);
                }
            }
        }

        entry.content_changed();
        Ok(structure_update(entry))
    }
}
