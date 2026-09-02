//! The reader's recently opened PDFs, kept between runs.
//!
//! This list is the durable half of the engine's approved-path set. An entry
//! gets here only after a file the OS itself named — a dialog pick, a drop the
//! window saw — actually opened; nothing the WebView says adds one. That is
//! what entitles `run()` to approve the whole list at startup: the home tab
//! opens a recent file by path, and a path a save may later overwrite still
//! has to be one this process watched the OS produce, even when it produced it
//! in an earlier run.
//!
//! It keeps its own file rather than joining `settings.toml`: this is the app's
//! bookkeeping and not the reader's to set, and folding a record with a security
//! role in among the settings would make hand-editing those a way to name a file
//! to open and then save over.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::store::{Store, Stored};

/// How many paths the file keeps. The home tab shows fewer: the surplus is
/// what keeps that shorter list full once entries whose file has since gone
/// are left out of it.
const RECENT_LIMIT: usize = 20;

/// What 0.1.3 and earlier wrote this list to. Read once into `recent-files.toml`
/// and deleted, so the reader keeps their list and the app writes one format.
const REPLACED_FILE_NAME: &str = "recent-files.json";

#[derive(Default, Deserialize, Serialize)]
struct RecentFilesDocument {
    files: Vec<PathBuf>,
}

impl Stored for RecentFilesDocument {
    const FILE_NAME: &'static str = "recent-files.toml";

    fn parse(contents: &str) -> Self {
        Self {
            files: recordable(toml::from_str::<Self>(contents).unwrap_or_default().files),
        }
    }

    fn render(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}

/// The entries a stored list may contribute.
///
/// What is on disk may come from an older version of the app, or from a reader
/// with a text editor. An unreadable list is an empty one — and a readable one
/// is still outside input, so every entry has to look like something this app
/// could have recorded before `run()` approves it: an absolute path to a `.pdf`.
/// Without that check a hand-edited list is a way to hand the WebView an
/// arbitrary file to open and then save over.
fn recordable(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = files
        .into_iter()
        .filter(|path| is_recordable(path))
        .collect();
    kept.truncate(RECENT_LIMIT);

    kept
}

/// The list the file this replaced held, held to the same rule.
fn replaced_files(contents: &str) -> Vec<PathBuf> {
    recordable(
        serde_json::from_str::<RecentFilesDocument>(contents)
            .unwrap_or_default()
            .files,
    )
}

#[derive(Clone)]
pub struct RecentFiles(Store<RecentFilesDocument>);

impl RecentFiles {
    pub fn load(app: &AppHandle) -> Self {
        let store = Store::<RecentFilesDocument>::load(app);

        // Only where this run has nothing of its own: a list already in the new
        // file is the later of the two.
        store.adopt(REPLACED_FILE_NAME, |document, contents| {
            if document.files.is_empty() {
                document.files = replaced_files(contents);
            }
        });

        Self(store)
    }

    /// Every stored path, including any whose file has gone — approving one
    /// that no longer exists costs nothing, and the open would fail on its own
    /// were the file to come back after this run started.
    pub fn stored(&self) -> Vec<PathBuf> {
        self.0.read(|document| document.files.clone())
    }

    /// The paths still on disk, most recently opened first.
    ///
    /// Only the answer is filtered, never the file: an entry on a drive that
    /// happens to be unmounted comes back when the drive does, and losing it
    /// would be a worse trade than carrying a dead path in a 20-entry list.
    pub fn existing(&self) -> Vec<PathBuf> {
        self.stored()
            .into_iter()
            .filter(|path| path.is_file())
            .collect()
    }

    pub fn record(&self, path: &Path) {
        self.0.write(|document| promote(&mut document.files, path));
    }
}

/// Moves `path` to the front, keeping one entry per path and at most
/// `RECENT_LIMIT` of them. Entries match the way `is_approved` matches, by
/// `Path`'s own equality, which reads a path as its components and so takes
/// `/a/./b.pdf` for `/a/b.pdf` — a coarser rule than the frontend's verbatim
/// `tabIdForPath`, and the safe direction for the two to differ in: it can
/// only merge two names for one file, never split one file into two entries
/// the approval check would then disagree about.
fn promote(entries: &mut Vec<PathBuf>, path: &Path) {
    entries.retain(|entry| entry != path);
    entries.insert(0, path.to_path_buf());
    entries.truncate(RECENT_LIMIT);
}

/// The shape every recorded path has: absolute, and named as a PDF — the same
/// two things the frontend's `isPdfPath` and the OS's own dialogs guarantee of
/// what reaches `open_pdf_from_path`.
fn is_recordable(path: &Path) -> bool {
    path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

/// Async so the `is_file` probe behind `existing()` runs off the main thread:
/// an entry on a stalled network mount would otherwise park the whole UI, and
/// the home tab asks for this list on every visit.
#[tauri::command]
pub async fn recent_pdfs(state: State<'_, RecentFiles>) -> Result<Vec<String>, String> {
    let recent = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        recent
            .existing()
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    })
    .await
    .map_err(|error| format!("recent files task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(entries: &[PathBuf]) -> Vec<&str> {
        entries.iter().filter_map(|entry| entry.to_str()).collect()
    }

    #[test]
    fn promotes_a_repeat_open_instead_of_repeating_it() {
        let mut entries = vec![PathBuf::from("/a.pdf"), PathBuf::from("/b.pdf")];

        promote(&mut entries, Path::new("/b.pdf"));

        assert_eq!(paths(&entries), ["/b.pdf", "/a.pdf"]);
    }

    #[test]
    fn keeps_only_the_most_recent_entries() {
        let mut entries = Vec::new();

        for index in 0..RECENT_LIMIT + 5 {
            promote(&mut entries, Path::new(&format!("/{index}.pdf")));
        }

        assert_eq!(entries.len(), RECENT_LIMIT);
        assert_eq!(entries.first(), Some(&PathBuf::from("/24.pdf")));
        assert_eq!(entries.last(), Some(&PathBuf::from("/5.pdf")));
    }

    #[test]
    fn rejects_stored_entries_this_app_could_not_have_recorded() {
        assert!(is_recordable(Path::new("/docs/a.pdf")));
        assert!(is_recordable(Path::new("/docs/A.PDF")));
        assert!(!is_recordable(Path::new("/home/roy/.ssh/authorized_keys")));
        assert!(!is_recordable(Path::new("relative.pdf")));

        let parsed =
            RecentFilesDocument::parse(r#"files = ["/docs/a.pdf", "relative.pdf", "/etc/passwd"]"#);

        assert_eq!(paths(&parsed.files), ["/docs/a.pdf"]);
        // The same rule over what the file this replaced held.
        assert_eq!(
            paths(&replaced_files(
                r#"{"files":["/docs/b.pdf","/etc/shadow"]}"#
            )),
            ["/docs/b.pdf"]
        );
    }

    #[test]
    fn folds_the_names_path_equality_reads_alike() {
        let mut entries = vec![PathBuf::from("/docs/a.pdf")];

        promote(&mut entries, Path::new("/docs/./a.pdf"));

        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn an_unreadable_list_reads_as_empty() {
        assert!(RecentFilesDocument::parse("{ not toml").files.is_empty());
        assert!(RecentFilesDocument::parse("").files.is_empty());
        assert!(replaced_files("{ not json").is_empty());
    }

    #[test]
    fn round_trips_the_list_through_the_file() {
        let document = RecentFilesDocument {
            files: vec![PathBuf::from("/docs/a.pdf"), PathBuf::from("/docs/b.pdf")],
        };
        let rendered = document.render().expect("the list should render");

        assert_eq!(
            paths(&RecentFilesDocument::parse(&rendered).files),
            ["/docs/a.pdf", "/docs/b.pdf"]
        );
    }
}
