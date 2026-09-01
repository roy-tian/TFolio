//! The reader's own settings, kept between runs.
//!
//! Everything here is a choice about how the app behaves, never about one
//! document — a page-number range belongs to the PDF it numbers and is asked
//! for again each time, while the style it is set in is the reader's and is
//! remembered. The file lives beside the recent list, in the app's data
//! directory, so it is per user and per machine.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::pdfium::PageNumbersPreferences;

const PREFERENCES_FILE_NAME: &str = "preferences.json";

/// The file's shape. Every setting is optional, so a version that did not write
/// one — or a reader who deleted it by hand — leaves the frontend to fall back
/// to its own defaults rather than being handed something invented here.
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredPreferences {
    page_numbers: Option<PageNumbersPreferences>,
}

struct PreferencesInner {
    /// None when no app data directory resolves. Settings then last for this
    /// run only, which beats failing the dialog that set them.
    file: Option<PathBuf>,
    stored: Mutex<StoredPreferences>,
}

#[derive(Clone)]
pub struct Preferences(Arc<PreferencesInner>);

impl Preferences {
    pub fn load(app: &AppHandle) -> Self {
        let file = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(PREFERENCES_FILE_NAME));
        let stored = file.as_deref().map(read_stored).unwrap_or_default();

        Self(Arc::new(PreferencesInner {
            file,
            stored: Mutex::new(stored),
        }))
    }

    fn page_numbers(&self) -> Option<PageNumbersPreferences> {
        self.0
            .stored
            .lock()
            .ok()
            .and_then(|stored| stored.page_numbers)
    }

    fn set_page_numbers(&self, preferences: PageNumbersPreferences) {
        let Ok(mut stored) = self.0.stored.lock() else {
            return;
        };

        stored.page_numbers = Some(preferences);
        write_stored(self.0.file.as_deref(), &stored);
    }
}

/// What is on disk may come from an older version of the app, or from a reader
/// with a text editor. An unreadable file is an unset one: the values it holds
/// only ever preselect controls the reader is looking at, so the worst a
/// discarded file costs is one dialog opened at its defaults.
fn read_stored(file: &Path) -> StoredPreferences {
    fs::read_to_string(file)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

/// Writes the settings, and gives up quietly if it cannot — remembering a style
/// is a convenience, and no failure to record one may fail the apply that set
/// it.
fn write_stored(file: Option<&Path>, stored: &StoredPreferences) {
    let Some(file) = file else {
        return;
    };
    let Some(directory) = file.parent() else {
        return;
    };

    if fs::create_dir_all(directory).is_err() {
        return;
    }

    if let Ok(contents) = serde_json::to_string_pretty(stored) {
        let _ = fs::write(file, contents);
    }
}

/// The page-number style the reader last applied, or `None` if they never have.
/// Serde is the whole validation: an enum outside the schema fails the read and
/// leaves the dialog on its defaults.
#[tauri::command]
pub async fn page_numbers_preferences(
    state: State<'_, Preferences>,
) -> Result<Option<PageNumbersPreferences>, String> {
    Ok(state.page_numbers())
}

#[tauri::command]
pub async fn set_page_numbers_preferences(
    preferences: PageNumbersPreferences,
    state: State<'_, Preferences>,
) -> Result<(), String> {
    state.set_page_numbers(preferences);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built from the wire shape rather than the enum variants, so this also
    /// pins the names the frontend sends.
    fn preferences() -> PageNumbersPreferences {
        serde_json::from_str(
            r#"{"mode":"duplex","position":"bottomRight","smartColor":false,
                "blankNumbered":false,"blankCounted":true}"#,
        )
        .expect("the stored shape should read back")
    }

    #[test]
    fn round_trips_a_style_through_the_file() {
        let directory =
            std::env::temp_dir().join(format!("tfolio-preferences-{}", std::process::id()));
        let file = directory.join(PREFERENCES_FILE_NAME);
        let _ = fs::remove_file(&file);

        write_stored(
            Some(&file),
            &StoredPreferences {
                page_numbers: Some(preferences()),
            },
        );

        assert_eq!(read_stored(&file).page_numbers, Some(preferences()));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_unreadable_file_reads_as_unset() {
        let directory =
            std::env::temp_dir().join(format!("tfolio-preferences-broken-{}", std::process::id()));
        let file = directory.join(PREFERENCES_FILE_NAME);
        fs::create_dir_all(&directory).expect("create the test directory");

        // Missing, malformed, and holding a value outside the schema.
        assert!(read_stored(&file).page_numbers.is_none());
        fs::write(&file, "{ not json").expect("write a malformed file");
        assert!(read_stored(&file).page_numbers.is_none());
        fs::write(&file, r#"{"pageNumbers":{"mode":"triple"}}"#).expect("write a bad value");
        assert!(read_stored(&file).page_numbers.is_none());

        let _ = fs::remove_dir_all(&directory);
    }
}
