//! The PDFs the OS itself asks this app to open.
//!
//! Double-clicking a document, or picking this app from the file manager's
//! "open with", names the file to the handler and nothing else: on Windows and
//! Linux as arguments to a fresh process, on macOS as an event to the running
//! one. Either way the path arrives before there is a workspace to put it in,
//! so it is parked here until the frontend asks — and a path that arrives once
//! the workspace is already up is announced, so the same asking runs again.
//!
//! A path that gets here is approved for `open_pdf_from_path` exactly as a drop
//! or a dialog pick is, and for the same reason: the OS produced it in this
//! process's sight, out of the reader's own gesture on a file they had already
//! chosen, and no page code had a say in it.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::pdfium::PdfiumState;

/// Says a PDF the OS named is waiting. Carries nothing: the queue below is
/// drained by a command, so the paths cross the boundary once, by one route.
/// Spelled again in `App.tsx`, which listens for it.
pub const OPEN_REQUESTED_EVENT: &str = "launch://open-requested";

/// The paths the OS has named and the workspace has yet to take.
///
/// A queue rather than a single path: `%F` puts every file the reader selected
/// on one command line, and a second double-click can land while the first
/// file is still opening.
#[derive(Default)]
pub struct LaunchQueue(Mutex<Vec<PathBuf>>);

impl LaunchQueue {
    fn extend(&self, paths: Vec<PathBuf>) {
        if let Ok(mut queued) = self.0.lock() {
            queued.extend(paths);
        }
    }

    fn take(&self) -> Vec<PathBuf> {
        self.0
            .lock()
            .map(|mut queued| std::mem::take(&mut *queued))
            .unwrap_or_default()
    }
}

/// Approves `paths`, parks them, and tells a workspace that may already be up.
///
/// Silent when either state is missing: `setup` manages both before the event
/// loop runs, so it cannot happen — and an OS event is no place to panic if it
/// ever did.
pub fn queue_open(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }

    let (Some(pdfium), Some(queue)) = (
        app.try_state::<PdfiumState>(),
        app.try_state::<LaunchQueue>(),
    ) else {
        return;
    };

    pdfium.approve_paths(paths.iter());
    queue.extend(paths);
    let _ = app.emit(OPEN_REQUESTED_EVENT, ());
}

/// The PDFs named among one launch's arguments — the program's own name
/// already dropped — resolved against the directory it was launched from and
/// kept in the order the OS gave them.
///
/// Everything else is left alone rather than refused: a launch carries
/// switches this app never reads, and an argument that names no readable PDF
/// is not something a reader asked to see. The test for one is the shape the
/// recent list and `open_pdf_from_path` already require of a path — absolute,
/// named as a PDF, and a file that is there.
pub fn pdf_paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|argument| !argument.starts_with('-'))
        .map(|argument| {
            let path = PathBuf::from(argument);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };

            // Collected through its components, which drops the `.` segments a
            // shell leaves in a name. The frontend matches an open document by
            // its path verbatim, so `/docs/./a.pdf` would otherwise put a
            // second tab on a file the reader already has open — two edit
            // histories over one file, and whichever saves last wins.
            path.components().collect::<PathBuf>()
        })
        .filter(|path| is_pdf_file(path))
        .collect()
}

/// This process's own arguments, as PDF paths.
///
/// Arguments are read as `OsString` and the ones that are not UTF-8 dropped:
/// `std::env::args` would panic on one, and a path that cannot be a `String`
/// could not survive the trip to the frontend and back anyway.
pub fn pdf_paths_from_this_launch() -> Vec<PathBuf> {
    let arguments = std::env::args_os()
        .skip(1)
        .filter_map(|argument| argument.into_string().ok());

    pdf_paths_from_args(arguments, &std::env::current_dir().unwrap_or_default())
}

/// The PDFs among the `file://` URLs macOS names in an open event. A URL of
/// any other scheme has no file behind it, and this app registers none.
#[cfg(target_os = "macos")]
pub fn pdf_paths_from_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| is_pdf_file(path))
        .collect()
}

/// The recent list's own test for a path, plus the file being there.
///
/// Absolute is half of that test and load-bearing here: a second instance whose
/// working directory it could not read hands over an empty one, and a name left
/// relative would then be resolved — and approved — against the directory the
/// *running* process happens to sit in.
fn is_pdf_file(path: &Path) -> bool {
    crate::recent::is_recordable(path) && path.is_file()
}

/// The PDFs the OS has asked this run to open and the workspace has not taken
/// yet. Draining, not reading: each path opens once, however many times a page
/// asks.
#[tauri::command]
pub async fn take_launch_pdfs(state: State<'_, LaunchQueue>) -> Result<Vec<String>, String> {
    Ok(state
        .take()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("tfolio-launch-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        directory
    }

    fn write_file(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"%PDF-1.7\n").expect("scratch file");

        path
    }

    #[test]
    fn takes_the_pdfs_a_launch_names() {
        let directory = scratch("named");
        let first = write_file(&directory, "first.pdf");
        // Named as a PDF is a question about the name, not its case.
        let second = write_file(&directory, "second.PDF");

        let paths = pdf_paths_from_args(
            [
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            &directory,
        );

        assert_eq!(paths, vec![first, second]);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn resolves_a_relative_name_against_the_launch_directory() {
        let directory = scratch("relative");
        let file = write_file(&directory, "relative.pdf");

        assert_eq!(
            pdf_paths_from_args(["relative.pdf".to_string()], &directory),
            vec![file]
        );

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn drops_the_dot_segments_a_relative_name_carries() {
        let directory = scratch("dotted");
        let file = write_file(&directory, "dotted.pdf");

        // Compared as strings, because that is what crosses to the frontend and
        // `Path`'s own equality reads `.` away before a test could see it.
        assert_eq!(
            pdf_paths_from_args(["./dotted.pdf".to_string()], &directory)
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![file.to_string_lossy().into_owned()]
        );

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn refuses_a_name_no_launch_directory_can_make_absolute() {
        // What a second instance that could not read its own working directory
        // hands over. Resolving the name against this process's directory
        // instead would open — and approve — a different file of that name.
        assert!(pdf_paths_from_args(["some.pdf".to_string()], Path::new("")).is_empty());
    }

    #[test]
    fn leaves_everything_that_is_not_a_readable_pdf() {
        let directory = scratch("other");
        write_file(&directory, "notes.txt");
        fs::create_dir(directory.join("folder.pdf")).expect("scratch directory");

        let paths = pdf_paths_from_args(
            [
                "--flag".to_string(),
                "notes.txt".to_string(),
                "missing.pdf".to_string(),
                "folder.pdf".to_string(),
            ],
            &directory,
        );

        assert!(paths.is_empty(), "{paths:?}");

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn drains_the_queue_once() {
        let queue = LaunchQueue::default();
        queue.extend(vec![PathBuf::from("/tmp/first.pdf")]);
        queue.extend(vec![PathBuf::from("/tmp/second.pdf")]);

        assert_eq!(
            queue.take(),
            vec![
                PathBuf::from("/tmp/first.pdf"),
                PathBuf::from("/tmp/second.pdf")
            ]
        );
        assert!(queue.take().is_empty());
    }
}
