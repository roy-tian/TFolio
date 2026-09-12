//! The OS names a PDF before there is a workspace to put it in, so it waits here
//! until asked — approved like a dialog pick, since the OS named it, not page code.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{pdfium::PdfiumState, windows::focus_target};

/// Carries nothing: the paths cross the boundary once, by the command that
/// drains the queue. Spelled again in `App.tsx`, which listens for it.
pub const OPEN_REQUESTED_EVENT: &str = "launch://open-requested";

/// `%F` may supply several files; `None` holds launches before any window exists.
#[derive(Default)]
pub struct LaunchQueue(Mutex<HashMap<Option<String>, Vec<PathBuf>>>);

impl LaunchQueue {
    fn extend(&self, window: Option<String>, paths: Vec<PathBuf>) {
        if let Ok(mut queued) = self.0.lock() {
            queued.entry(window).or_default().extend(paths);
        }
    }

    fn take(&self, window: &str) -> Vec<PathBuf> {
        let Ok(mut queued) = self.0.lock() else {
            return Vec::new();
        };

        let mut taken = queued.remove(&None).unwrap_or_default();
        taken.extend(queued.remove(&Some(window.to_string())).unwrap_or_default());

        taken
    }
}

/// Return the queued target so a focus change cannot make the caller raise another window.
pub fn queue_open(app: &AppHandle, paths: Vec<PathBuf>) -> Option<WebviewWindow> {
    if paths.is_empty() {
        return None;
    }

    let (Some(pdfium), Some(queue)) = (
        app.try_state::<PdfiumState>(),
        app.try_state::<LaunchQueue>(),
    ) else {
        return None;
    };

    pdfium.approve_paths(paths.iter());

    let target = focus_target(app);
    let label = target.as_ref().map(|window| window.label().to_string());
    queue.extend(label.clone(), paths);

    if let Some(label) = label {
        let _ = app.emit_to(label.as_str(), OPEN_REQUESTED_EVENT, ());
    }

    target
}

/// Non-PDF arguments are left alone rather than refused — a launch carries
/// switches this app never reads — and the path test is the recent list's own.
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

            // Components drop the `.` a shell leaves in a name: the frontend matches
            // paths verbatim, so a `.` would open a second edit history on one file.
            path.components().collect::<PathBuf>()
        })
        .filter(|path| is_pdf_file(path))
        .collect()
}

/// `args_os`, not `args`: `std::env::args` panics on non-UTF-8, which could not
/// survive the trip to the frontend anyway.
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

/// The recent list's test, plus the file being there. Absolute is load-bearing:
/// a relative name would resolve against the running process's own directory.
fn is_pdf_file(path: &Path) -> bool {
    crate::recent::is_recordable(path) && path.is_file()
}

#[tauri::command]
pub async fn take_launch_pdfs(
    state: State<'_, LaunchQueue>,
    window: WebviewWindow,
) -> Result<Vec<String>, String> {
    Ok(state
        .take(window.label())
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
        // A second instance that could not read its working directory hands this
        // over; resolving it here would open — and approve — a different file.
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
        queue.extend(Some("main".into()), vec![PathBuf::from("/tmp/first.pdf")]);
        queue.extend(Some("main".into()), vec![PathBuf::from("/tmp/second.pdf")]);

        assert_eq!(
            queue.take("main"),
            vec![
                PathBuf::from("/tmp/first.pdf"),
                PathBuf::from("/tmp/second.pdf")
            ]
        );
        assert!(queue.take("main").is_empty());
    }

    #[test]
    fn hands_each_window_only_what_was_queued_for_it() {
        let queue = LaunchQueue::default();
        queue.extend(Some("main".into()), vec![PathBuf::from("/tmp/first.pdf")]);
        queue.extend(
            Some("window-2".into()),
            vec![PathBuf::from("/tmp/second.pdf")],
        );

        assert_eq!(
            queue.take("window-2"),
            vec![PathBuf::from("/tmp/second.pdf")]
        );
        assert_eq!(queue.take("main"), vec![PathBuf::from("/tmp/first.pdf")]);
    }

    #[test]
    fn gives_what_arrived_before_any_window_to_the_first_asker() {
        let queue = LaunchQueue::default();
        queue.extend(None, vec![PathBuf::from("/tmp/launched.pdf")]);

        assert_eq!(queue.take("main"), vec![PathBuf::from("/tmp/launched.pdf")]);
        assert!(queue.take("window-2").is_empty());
    }
}
