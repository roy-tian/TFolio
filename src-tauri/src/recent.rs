//! Only files the OS itself named get here, which is what entitles startup to
//! approve the list — kept out of `settings.toml`, which stays safe to hand-edit.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::store::{Store, Stored};

/// The home tab pages the list in as the user scrolls; the surplus covers
/// entries whose file has since gone.
const RECENT_LIMIT: usize = 255;

/// What 0.1.3 and earlier wrote this list to.
const REPLACED_FILE_NAME: &str = "recent-files.json";

const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 8.0;
const MAX_PAGE_NUMBER: u32 = i32::MAX as u32;
const MAX_ANCHOR_FRACTION: f64 = 100.0;

/// A point on a page, not a scroll offset: page sizes change with window and
/// zoom, while the point goes back under the reading line at either size.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentPdfView {
    view_mode: String,
    zoom: RecentPdfZoom,
    position: RecentPdfPosition,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentPdfZoom {
    custom_scale: f64,
    fit_page: u32,
    mode: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentPdfPosition {
    fraction_x: f64,
    fraction_y: f64,
    page_number: u32,
}

impl RecentPdfView {
    fn is_valid(&self) -> bool {
        matches!(self.view_mode.as_str(), "single" | "book" | "thumbnail")
            && matches!(
                self.zoom.mode.as_str(),
                "auto" | "custom" | "fit-page" | "fit-width"
            )
            && self.zoom.custom_scale.is_finite()
            && (MIN_ZOOM..=MAX_ZOOM).contains(&self.zoom.custom_scale)
            && (1..=MAX_PAGE_NUMBER).contains(&self.zoom.fit_page)
            && (1..=MAX_PAGE_NUMBER).contains(&self.position.page_number)
            && self.position.fraction_x.is_finite()
            && self.position.fraction_y.is_finite()
            && self.position.fraction_x.abs() <= MAX_ANCHOR_FRACTION
            && self.position.fraction_y.abs() <= MAX_ANCHOR_FRACTION
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct RecentPdfViewEntry {
    path: PathBuf,
    #[serde(flatten)]
    view: RecentPdfView,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct RecentFilesDocument {
    files: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    views: Vec<RecentPdfViewEntry>,
}

impl Stored for RecentFilesDocument {
    const FILE_NAME: &'static str = "recent-files.toml";

    fn parse(contents: &str) -> Self {
        let table = contents.parse::<toml::Table>().unwrap_or_default();
        let files = recordable(
            table
                .get("files")
                .cloned()
                .and_then(|value| Vec::<PathBuf>::deserialize(value).ok())
                .unwrap_or_default(),
        );
        // A view schema from another version, or a damaged view, must not cost
        // the paths that still authorise and populate the recent-file list.
        let views = table
            .get("views")
            .cloned()
            .and_then(|value| Vec::<RecentPdfViewEntry>::deserialize(value).ok())
            .map(|views| recordable_views(views, &files))
            .unwrap_or_default();

        Self { files, views }
    }

    fn render(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}

/// Outside input: every entry must look like something this app recorded —
/// absolute, a `.pdf` — or a hand edit names an arbitrary file to save over.
fn recordable(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = files
        .into_iter()
        .filter(|path| is_recordable(path))
        .collect();
    kept.truncate(RECENT_LIMIT);

    kept
}

/// Bookkeeping for a path already approved, never another route in: orphans and
/// viewer-impossible values are dropped.
fn recordable_views(views: Vec<RecentPdfViewEntry>, files: &[PathBuf]) -> Vec<RecentPdfViewEntry> {
    let mut kept = Vec::new();

    for entry in views {
        if entry.view.is_valid()
            && files.contains(&entry.path)
            && !kept
                .iter()
                .any(|kept: &RecentPdfViewEntry| kept.path == entry.path)
        {
            kept.push(entry);
        }
    }

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
                document.views.clear();
            }
        });

        Self(store)
    }

    /// Includes paths whose file has gone: approving a missing one costs nothing,
    /// and the open fails on its own if the file returns after this run started.
    pub fn stored(&self) -> Vec<PathBuf> {
        self.0.read(|document| document.files.clone())
    }

    /// Only the answer is filtered, never the file: an unmounted drive's entries
    /// come back when it does — a better trade than losing them over a dead path.
    pub fn existing(&self) -> Vec<PathBuf> {
        self.stored()
            .into_iter()
            .filter(|path| path.is_file())
            .collect()
    }

    pub fn record(&self, path: &Path) {
        self.0.write(|document| {
            promote(&mut document.files, path);
            // A view cannot outlive the bounded path list that authorises and
            // identifies it. Reopening an existing path keeps its view.
            document
                .views
                .retain(|entry| document.files.contains(&entry.path));
        });
    }

    /// Forgets one entry, withdrawing the next run's approval of the path with
    /// it. This run's granted approval stays: removing from a list is not an
    /// accusation against a document the reader may still have open.
    pub fn remove(&self, path: &Path) {
        // Checked first, as in `record_view`, so an unknown path rewrites nothing.
        if !self
            .0
            .read(|document| document.files.iter().any(|entry| entry == path))
        {
            return;
        }

        self.0.write(|document| forget(document, path));
    }

    pub fn view(&self, path: &Path) -> Option<RecentPdfView> {
        self.0.read(|document| {
            document
                .views
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| entry.view.clone())
        })
    }

    /// The folder of the most recently opened PDF that still exists: where a
    /// document that has never been saved offers itself, beside the last thing
    /// the reader opened. A dialog pointed at a missing folder opens nowhere.
    pub fn last_opened_dir(&self) -> Option<PathBuf> {
        self.stored().into_iter().find_map(|path| {
            let directory = path.parent()?.to_path_buf();
            (!directory.as_os_str().is_empty() && directory.is_dir()).then_some(directory)
        })
    }

    /// Only for a path already recent: a view never promotes a WebView-provided
    /// path, and the check runs before `Store::write` so an unknown path rewrites nothing.
    pub fn record_view(&self, path: &Path, view: RecentPdfView) -> bool {
        if !view.is_valid()
            || !self
                .0
                .read(|document| document.files.iter().any(|entry| entry == path))
        {
            return false;
        }

        let mut recorded = false;

        self.0
            .write(|document| recorded = remember_view(document, path, view));

        recorded
    }
}

fn remember_view(document: &mut RecentFilesDocument, path: &Path, view: RecentPdfView) -> bool {
    let Some(stored_path) = document.files.iter().find(|entry| *entry == path).cloned() else {
        return false;
    };

    document.views.retain(|entry| entry.path != stored_path);
    document.views.push(RecentPdfViewEntry {
        path: stored_path,
        view,
    });

    true
}

/// `Path` equality reads `.` away, folding `/a/./b.pdf` into `/a/b.pdf` — coarser
/// than the frontend's verbatim match, and safely so: it can only merge, never split.
fn promote(entries: &mut Vec<PathBuf>, path: &Path) {
    entries.retain(|entry| entry != path);
    entries.insert(0, path.to_path_buf());
    entries.truncate(RECENT_LIMIT);
}

/// A view cannot outlive the bounded path list that authorises and identifies
/// it, so the removed path's view goes with the path.
fn forget(document: &mut RecentFilesDocument, path: &Path) {
    document.files.retain(|entry| entry != path);
    document
        .views
        .retain(|entry| document.files.contains(&entry.path));
}

/// Absolute and named as a PDF — the same guarantees the OS's own dialogs give
/// what reaches `open_pdf_from_path`. `launch.rs` reads this for a launch's
/// PDFs, beside its images and Word documents.
pub(crate) fn is_recordable(path: &Path) -> bool {
    path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

/// Off the main thread: `is_file` on a stalled network mount would park the UI,
/// and the home tab asks for this list on every visit.
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

#[tauri::command]
pub async fn recent_pdf_view(
    path: String,
    state: State<'_, RecentFiles>,
) -> Result<Option<RecentPdfView>, String> {
    Ok(state.view(Path::new(&path)))
}

/// A convenience like the list itself: an unknown path changes nothing, and the
/// home tab re-reads the list rather than trusting the removal to matter.
#[tauri::command]
pub async fn remove_recent_pdf(path: String, state: State<'_, RecentFiles>) -> Result<(), String> {
    state.remove(Path::new(&path));
    Ok(())
}

/// Bounded here even though the frontend checks too: commands are callable by
/// any page code, and command input must not shape the next viewer's geometry.
#[tauri::command]
pub async fn set_recent_pdf_view(
    path: String,
    view: RecentPdfView,
    state: State<'_, RecentFiles>,
) -> Result<bool, String> {
    Ok(state.record_view(Path::new(&path), view))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(entries: &[PathBuf]) -> Vec<&str> {
        entries.iter().filter_map(|entry| entry.to_str()).collect()
    }

    fn view() -> RecentPdfView {
        RecentPdfView {
            view_mode: "book".into(),
            zoom: RecentPdfZoom {
                custom_scale: 1.25,
                fit_page: 3,
                mode: "custom".into(),
            },
            position: RecentPdfPosition {
                fraction_x: 0.5,
                fraction_y: 0.4,
                page_number: 3,
            },
        }
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
        assert_eq!(
            entries.first(),
            Some(&PathBuf::from(format!("/{}.pdf", RECENT_LIMIT + 4)))
        );
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
    fn removal_takes_the_paths_view_with_it() {
        let mut document = RecentFilesDocument {
            files: vec![PathBuf::from("/docs/a.pdf"), PathBuf::from("/docs/b.pdf")],
            views: Vec::new(),
        };
        assert!(remember_view(
            &mut document,
            Path::new("/docs/a.pdf"),
            view()
        ));

        forget(&mut document, Path::new("/docs/./a.pdf"));

        assert_eq!(paths(&document.files), ["/docs/b.pdf"]);
        assert!(document.views.is_empty());
    }

    #[test]
    fn forgetting_an_unknown_path_leaves_the_list_alone() {
        let mut document = RecentFilesDocument {
            files: vec![PathBuf::from("/docs/a.pdf")],
            views: Vec::new(),
        };

        forget(&mut document, Path::new("/docs/other.pdf"));

        assert_eq!(paths(&document.files), ["/docs/a.pdf"]);
    }

    #[test]
    fn an_unreadable_list_reads_as_empty() {
        assert!(RecentFilesDocument::parse("{ not toml").files.is_empty());
        assert!(RecentFilesDocument::parse("").files.is_empty());
        assert!(replaced_files("{ not json").is_empty());
    }

    #[test]
    fn round_trips_the_list_and_its_views_through_the_file() {
        let mut document = RecentFilesDocument {
            files: vec![PathBuf::from("/docs/a.pdf"), PathBuf::from("/docs/b.pdf")],
            views: Vec::new(),
        };
        assert!(remember_view(
            &mut document,
            Path::new("/docs/a.pdf"),
            view()
        ));
        let rendered = document.render().expect("the list should render");
        let parsed = RecentFilesDocument::parse(&rendered);

        assert_eq!(paths(&parsed.files), ["/docs/a.pdf", "/docs/b.pdf"]);
        assert_eq!(parsed.views[0].path, PathBuf::from("/docs/a.pdf"));
        assert_eq!(parsed.views[0].view, view());
    }

    #[test]
    fn a_view_cannot_add_a_path_to_the_recent_list() {
        let mut document = RecentFilesDocument {
            files: vec![PathBuf::from("/docs/a.pdf")],
            views: Vec::new(),
        };

        assert!(!remember_view(
            &mut document,
            Path::new("/docs/not-recent.pdf"),
            view()
        ));
        assert!(document.views.is_empty());
        assert_eq!(paths(&document.files), ["/docs/a.pdf"]);
    }

    #[test]
    fn rejects_unusable_stored_views_without_losing_their_paths() {
        let parsed = RecentFilesDocument::parse(
            r#"
            files = ["/docs/a.pdf"]

            [[views]]
            path = "/docs/a.pdf"
            viewMode = "single"

            [views.zoom]
            customScale = 1000.0
            fitPage = 1
            mode = "custom"

            [views.position]
            fractionX = 0.5
            fractionY = 0.0
            pageNumber = 1
            "#,
        );

        assert_eq!(paths(&parsed.files), ["/docs/a.pdf"]);
        assert!(parsed.views.is_empty());

        let wrong_shape = RecentFilesDocument::parse(
            r#"
            files = ["/docs/a.pdf"]
            views = "from another version"
            "#,
        );
        assert_eq!(paths(&wrong_shape.files), ["/docs/a.pdf"]);
        assert!(wrong_shape.views.is_empty());
    }
}
