//! The one way this app keeps a file of its own between runs.
//!
//! Both files it keeps — the reader's settings and their recent list — answer
//! the same three questions, and have to answer them the same way: where the
//! file lives (the app data directory, so per user and per machine), what an
//! unreadable one means (nothing was stored), and what a failed write costs
//! (nothing — everything kept this way is a convenience, and no failure to
//! record one may fail the gesture that earned it). Keeping those answers in
//! one place is what stops them drifting apart.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Manager};

/// The value one file holds.
///
/// `parse` is total on purpose: what is on disk may come from an older version
/// of the app, or from a reader with a text editor, so it never reports an
/// error — only how much of the file it could believe. `render` may decline,
/// and a declined write leaves the last good file where it was.
pub trait Stored: Default {
    const FILE_NAME: &'static str;

    fn parse(contents: &str) -> Self;

    fn render(&self) -> Option<String>;
}

struct StoreInner<T> {
    /// None when no app data directory resolves. The value then lasts for this
    /// run only, which beats failing the gesture that set it over having
    /// nowhere to write it down.
    file: Option<PathBuf>,
    value: Mutex<T>,
}

pub struct Store<T>(Arc<StoreInner<T>>);

// Derived, this would ask `T: Clone`; the handle is an `Arc` and clones
// whatever it points at.
impl<T> Clone for Store<T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<T: Stored> Store<T> {
    pub fn load(app: &AppHandle) -> Self {
        Self::at(
            app.path()
                .app_data_dir()
                .ok()
                .map(|directory| directory.join(T::FILE_NAME)),
        )
    }

    /// `load` with the directory already resolved, so the tests can point a
    /// store at a scratch file instead of the reader's own.
    fn at(file: Option<PathBuf>) -> Self {
        let value = file
            .as_deref()
            .and_then(|file| fs::read_to_string(file).ok())
            .map(|contents| T::parse(&contents))
            .unwrap_or_default();

        Self(Arc::new(StoreInner {
            file,
            value: Mutex::new(value),
        }))
    }

    /// The directory the file sits in, for the one caller that has to look at
    /// what an older version of the app left beside it.
    fn directory(&self) -> Option<&Path> {
        self.0.file.as_deref().and_then(Path::parent)
    }

    /// Folds what an older version of the app left beside this file into the
    /// value, then removes it — so this runs once, on the first run after the
    /// file it reads was replaced. `fold` decides what to do with what it
    /// finds; the value it is handed is whatever the current file already held,
    /// which is the newer of the two and should win.
    pub fn adopt(&self, replaced: &str, fold: impl FnOnce(&mut T, &str)) {
        let Some(directory) = self.directory() else {
            return;
        };
        let file = directory.join(replaced);
        let Ok(contents) = fs::read_to_string(&file) else {
            return;
        };

        // Removed only once the fold is actually on disk: this is the last
        // other copy of what was just read, so a run that could not write it
        // down must not be the run that drops it. It keeps until one can.
        if self.write(|value| fold(value, &contents)) {
            let _ = fs::remove_file(&file);
        }
    }

    pub fn read<R>(&self, take: impl FnOnce(&T) -> R) -> R {
        match self.0.value.lock() {
            Ok(value) => take(&value),
            // A poisoned lock is a panic that has already happened; reading the
            // file's defaults keeps this run going rather than spreading it.
            Err(_) => take(&T::default()),
        }
    }

    /// Applies `change` and writes the result out, giving up quietly at every
    /// step it cannot take. Answers whether the file now holds the change —
    /// only `adopt`, which is about to delete the last other copy of it, has
    /// any reason to ask.
    pub fn write(&self, change: impl FnOnce(&mut T)) -> bool {
        let Ok(mut value) = self.0.value.lock() else {
            return false;
        };

        change(&mut value);

        let Some(file) = self.0.file.as_deref() else {
            return false;
        };
        let Some(directory) = file.parent() else {
            return false;
        };

        if fs::create_dir_all(directory).is_err() {
            return false;
        }

        let Some(contents) = value.render() else {
            return false;
        };

        fs::write(file, contents).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file whose whole content is one line, so these tests are about the
    /// store and not about a format.
    #[derive(Default, PartialEq, Debug)]
    struct Probe(String);

    impl Stored for Probe {
        const FILE_NAME: &'static str = "probe.txt";

        fn parse(contents: &str) -> Self {
            Self(contents.trim().to_owned())
        }

        fn render(&self) -> Option<String> {
            // Nothing to say is nothing to write, which is how these tests ask
            // for a declined render.
            (!self.0.is_empty()).then(|| self.0.clone())
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("tfolio-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);

        directory
    }

    #[test]
    fn a_missing_or_unwritable_file_leaves_the_value_at_its_default() {
        let directory = scratch("missing");
        let store = Store::<Probe>::at(Some(directory.join(Probe::FILE_NAME)));

        assert_eq!(store.read(|probe| probe.0.clone()), "");

        // No directory resolved: the value lives for this run and no more.
        let nowhere = Store::<Probe>::at(None);
        assert!(!nowhere.write(|probe| probe.0 = "kept in memory".into()));
        assert_eq!(nowhere.read(|probe| probe.0.clone()), "kept in memory");

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn round_trips_the_value_through_the_file() {
        let directory = scratch("round-trip");
        let file = directory.join(Probe::FILE_NAME);
        let store = Store::<Probe>::at(Some(file.clone()));

        // The directory is made on the way, and a declined render leaves the
        // last good file where it was.
        assert!(store.write(|probe| probe.0 = "remembered".into()));
        assert!(!store.write(|probe| probe.0 = String::new()));
        assert_eq!(
            fs::read_to_string(&file).expect("the file should be there"),
            "remembered"
        );

        assert_eq!(
            Store::<Probe>::at(Some(file)).read(|probe| probe.0.clone()),
            "remembered"
        );

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn adopts_the_replaced_file_and_removes_it() {
        let directory = scratch("adopt");
        fs::create_dir_all(&directory).expect("create the test directory");
        let replaced = directory.join("replaced.txt");
        fs::write(&replaced, "from the older version").expect("write the replaced file");

        let store = Store::<Probe>::at(Some(directory.join(Probe::FILE_NAME)));
        store.adopt("replaced.txt", |probe, contents| {
            probe.0 = contents.trim().to_owned();
        });

        assert_eq!(
            store.read(|probe| probe.0.clone()),
            "from the older version"
        );
        assert!(!replaced.exists());

        let _ = fs::remove_dir_all(&directory);
    }

    /// The write is what earns the delete. A fold this store cannot record —
    /// here a render that declines — has to leave the reader's only other copy
    /// alone, so a later run can try again.
    #[test]
    fn keeps_the_replaced_file_when_the_write_did_not_land() {
        let directory = scratch("adopt-failed");
        fs::create_dir_all(&directory).expect("create the test directory");
        let replaced = directory.join("replaced.txt");
        fs::write(&replaced, "from the older version").expect("write the replaced file");

        let store = Store::<Probe>::at(Some(directory.join(Probe::FILE_NAME)));
        store.adopt("replaced.txt", |probe, _| probe.0 = String::new());

        assert!(replaced.exists());

        let _ = fs::remove_dir_all(&directory);
    }
}
