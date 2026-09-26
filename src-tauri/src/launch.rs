//! The OS names a file before there is a workspace to put it in, so it waits here
//! until asked — approved like a dialog pick, since the OS named it, not page code.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    convert::is_word_document,
    pdfium::{is_merge_image, PdfiumState},
    recent::is_recordable,
    windows::{focus_target, focus_target_except},
};

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

    /// Moves what waited on a window that is gone to `to`, or to whichever
    /// window asks next; answers whether there was anything to move.
    fn reroute(&self, from: &str, to: Option<String>) -> bool {
        let Ok(mut queued) = self.0.lock() else {
            return false;
        };

        match queued.remove(&Some(from.to_string())) {
            Some(paths) if !paths.is_empty() => {
                queued.entry(to).or_default().extend(paths);
                true
            }
            _ => false,
        }
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

/// A launch queued for a window that closed before taking it goes where a
/// new launch would go now, or else waits for the next window to ask.
pub fn reroute_launches(app: &AppHandle, gone: &str) {
    let Some(queue) = app.try_state::<LaunchQueue>() else {
        return;
    };

    let label = focus_target_except(app, Some(gone)).map(|window| window.label().to_string());

    if queue.reroute(gone, label.clone()) {
        if let Some(label) = label {
            let _ = app.emit_to(label.as_str(), OPEN_REQUESTED_EVENT, ());
        }
    }
}

/// Arguments this app cannot open are left alone rather than refused — a
/// launch carries switches this app never reads.
pub fn open_paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
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
        .filter(|path| is_openable_file(path))
        .collect()
}

/// `args_os`, not `args`: `std::env::args` panics on non-UTF-8, which could not
/// survive the trip to the frontend anyway.
pub fn open_paths_from_this_launch() -> Vec<PathBuf> {
    let arguments = std::env::args_os()
        .skip(1)
        .filter_map(|argument| argument.into_string().ok());

    open_paths_from_args(arguments, &std::env::current_dir().unwrap_or_default())
}

/// The openable files among the `file://` URLs macOS names in an open event.
/// A URL of any other scheme has no file behind it, and this app registers none.
#[cfg(target_os = "macos")]
pub fn open_paths_from_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| is_openable_file(path))
        .collect()
}

/// A PDF, an image, or a Word document. The dialog offers Word only with a
/// converter installed, but the OS already named this file: the open flow
/// refuses it in words rather than silently. Absolute is load-bearing: a
/// relative name would resolve against the running process's own directory.
fn is_openable_file(path: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && (is_recordable(path) || is_merge_image(path) || is_word_document(path))
}

#[tauri::command]
pub async fn take_launch_files(
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
    fn takes_the_files_a_launch_names() {
        let directory = scratch("named");
        let first = write_file(&directory, "first.pdf");
        // Named as a PDF is a question about the name, not its case.
        let second = write_file(&directory, "second.PDF");
        // The dialog's convertible offer: images and Word documents queue too.
        let photo = write_file(&directory, "photo.png");
        let letter = write_file(&directory, "letter.docx");

        let paths = open_paths_from_args(
            [
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
                photo.to_string_lossy().into_owned(),
                letter.to_string_lossy().into_owned(),
            ],
            &directory,
        );

        assert_eq!(paths, vec![first, second, photo, letter]);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn resolves_a_relative_name_against_the_launch_directory() {
        let directory = scratch("relative");
        let file = write_file(&directory, "relative.pdf");

        assert_eq!(
            open_paths_from_args(["relative.pdf".to_string()], &directory),
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
            open_paths_from_args(["./dotted.pdf".to_string()], &directory)
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
        assert!(open_paths_from_args(["some.pdf".to_string()], Path::new("")).is_empty());
    }

    #[test]
    fn leaves_everything_a_launch_cannot_open() {
        let directory = scratch("other");
        write_file(&directory, "notes.txt");
        fs::create_dir(directory.join("folder.pdf")).expect("scratch directory");

        let paths = open_paths_from_args(
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
    fn hands_a_gone_window_s_launches_to_another() {
        let queue = LaunchQueue::default();
        queue.extend(Some("window-2".into()), vec![PathBuf::from("/tmp/a.pdf")]);
        queue.extend(Some("main".into()), vec![PathBuf::from("/tmp/b.pdf")]);

        assert!(queue.reroute("window-2", Some("main".into())));
        assert!(queue.take("window-2").is_empty());
        assert_eq!(
            queue.take("main"),
            vec![PathBuf::from("/tmp/b.pdf"), PathBuf::from("/tmp/a.pdf")]
        );
    }

    #[test]
    fn holds_a_gone_window_s_launches_for_the_next_asker() {
        let queue = LaunchQueue::default();
        queue.extend(Some("main".into()), vec![PathBuf::from("/tmp/a.pdf")]);

        assert!(queue.reroute("main", None));
        assert_eq!(queue.take("window-3"), vec![PathBuf::from("/tmp/a.pdf")]);
        assert!(
            !queue.reroute("window-4", None),
            "a window with nothing queued moves nothing"
        );
    }

    #[test]
    fn gives_what_arrived_before_any_window_to_the_first_asker() {
        let queue = LaunchQueue::default();
        queue.extend(None, vec![PathBuf::from("/tmp/launched.pdf")]);

        assert_eq!(queue.take("main"), vec![PathBuf::from("/tmp/launched.pdf")]);
        assert!(queue.take("window-2").is_empty());
    }
}
