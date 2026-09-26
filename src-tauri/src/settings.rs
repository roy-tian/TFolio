//! The reader's own settings — how the app behaves, never one document's state —
//! in one TOML file per user and machine, theirs to edit, so revalidated on the way in.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    pdfium::{PageNumbersPreferences, WatermarkConfig},
    store::{Store, Stored},
};

/// What 0.1.3 and earlier kept, and all it kept: the page-number style.
const REPLACED_FILE_NAME: &str = "preferences.json";

pub const SETTINGS_CHANGED_EVENT: &str = "settings://changed";

/// Every setting optional: an older version or a hand deletion leaves the
/// frontend on its own defaults, and absent beats null — TOML has none to write.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    ui: Option<UiPreferences>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotate: Option<AnnotatePreferences>,
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<WatermarkConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_numbers: Option<PageNumbersPreferences>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct UiPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_mode: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct AnnotatePreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    highlight_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rect: Option<RectPreferences>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_note: Option<TextNotePreferences>,
}

/// Not `pdfium::RectStyle`: the reader picks one style with the effect inside it
/// and keeps the unused strength, so switching back draws what it drew before.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RectPreferences {
    color: String,
    effect: String,
    opacity: f64,
    strength: f64,
}

/// The same fields `pdfium::TextNoteStyle` takes, but that one is command input
/// and reads only one way; this crosses back out to the dialog that set it.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextNotePreferences {
    color: String,
    font_size: f64,
    opacity: f64,
}

impl Stored for Settings {
    const FILE_NAME: &'static str = "settings.toml";

    /// One section at a time: a value this version cannot place — older schema,
    /// reader's typo — costs that section, not the language with the styles.
    fn parse(contents: &str) -> Self {
        let table = contents.parse::<toml::Table>().unwrap_or_default();

        Self {
            ui: section(&table, "ui"),
            annotate: section(&table, "annotate"),
            watermark: section(&table, "watermark"),
            page_numbers: section(&table, "pageNumbers"),
        }
    }

    fn render(&self) -> Option<String> {
        toml::to_string_pretty(self).ok()
    }
}

impl Settings {
    /// Section by section, like `parse`: deserialising the command's argument
    /// straight into `Settings` would fail the whole write over one bad section.
    fn sent(document: &serde_json::Value) -> Self {
        Self {
            ui: sent_section(document, "ui"),
            annotate: sent_section(document, "annotate"),
            watermark: sent_section(document, "watermark"),
            page_numbers: sent_section(document, "pageNumbers"),
        }
    }
}

fn section<T: DeserializeOwned>(table: &toml::Table, key: &str) -> Option<T> {
    table
        .get(key)
        .cloned()
        .and_then(|value| T::deserialize(value).ok())
}

fn sent_section<T: DeserializeOwned>(document: &serde_json::Value, key: &str) -> Option<T> {
    document
        .get(key)
        .cloned()
        .and_then(|value| T::deserialize(value).ok())
}

/// Opens the settings, adopting what the file this replaced still holds. A
/// style already in `settings.toml` wins: the reader set that one later.
pub fn load(app: &AppHandle) -> Store<Settings> {
    let store = Store::<Settings>::load(app);

    store.adopt(REPLACED_FILE_NAME, |settings, contents| {
        settings.page_numbers = settings
            .page_numbers
            .or_else(|| replaced_page_numbers(contents));
    });

    store
}

fn replaced_page_numbers(contents: &str) -> Option<PageNumbersPreferences> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Replaced {
        page_numbers: Option<PageNumbersPreferences>,
    }

    serde_json::from_str::<Replaced>(contents)
        .ok()
        .and_then(|replaced| replaced.page_numbers)
}

#[tauri::command]
pub async fn settings(store: State<'_, Store<Settings>>) -> Result<Settings, String> {
    Ok(store.read(Clone::clone))
}

/// Takes the whole document rather than a patch: what arrives is the settings
/// entire, and a setting it drops is one the reader cleared — no merge could tell.
#[tauri::command]
pub async fn set_settings(
    settings: serde_json::Value,
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Store<Settings>>,
) -> Result<(), String> {
    let sent = Settings::sent(&settings);
    let written = sent.clone();
    let store = store.inner().clone();

    // The write is a blocking `fs::write`, which an async worker must not wait on.
    tauri::async_runtime::spawn_blocking(move || store.write(|stored| *stored = sent))
        .await
        .map_err(|error| format!("settings write task failed: {error}"))?;

    // Other windows write whole snapshots; a stale copy would overwrite these changes.
    for label in app.webview_windows().into_keys() {
        if label != window.label() {
            let _ = app.emit_to(label.as_str(), SETTINGS_CHANGED_EVENT, &written);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built from the wire shape rather than the enum variants, so this also
    /// pins the names the frontend sends.
    fn page_numbers() -> PageNumbersPreferences {
        serde_json::from_str(
            r#"{"mode":"duplex","position":"bottomRight","smartColor":false,
                "blankNumbered":false,"blankCounted":true}"#,
        )
        .expect("the stored shape should read back")
    }

    fn settings() -> Settings {
        Settings {
            ui: Some(UiPreferences {
                theme: Some("dark".into()),
                language: Some("en".into()),
                view_mode: None,
            }),
            annotate: Some(AnnotatePreferences {
                highlight_color: Some("#ffd54a".into()),
                rect: None,
                text_note: Some(TextNotePreferences {
                    color: "#d70015".into(),
                    font_size: 12.0,
                    opacity: 1.0,
                }),
            }),
            watermark: None,
            page_numbers: Some(page_numbers()),
        }
    }

    #[test]
    fn round_trips_every_section_through_the_file() {
        let rendered = settings().render().expect("the settings should render");
        let read = Settings::parse(&rendered);

        assert_eq!(read.ui.and_then(|ui| ui.theme).as_deref(), Some("dark"));
        assert_eq!(
            read.annotate
                .and_then(|annotate| annotate.text_note)
                .map(|note| note.font_size),
            Some(12.0)
        );
        assert_eq!(read.page_numbers, Some(page_numbers()));
    }

    /// Names the keys rather than trusting the derive, because they are also
    /// what the frontend reads.
    #[test]
    fn writes_the_names_the_frontend_reads() {
        let rendered = settings().render().expect("the settings should render");

        assert!(rendered.contains("[ui]"));
        assert!(rendered.contains("[annotate.textNote]"));
        assert!(rendered.contains("[pageNumbers]"));
        assert!(rendered.contains("fontSize"));
        assert!(!rendered.contains("[watermark]"));
        assert!(!rendered.contains("[import]"));
    }

    /// An older schema's watermark is the likeliest stray in the frontend's copy;
    /// it must cost its section alone, not every setting the same write carried.
    #[test]
    fn a_section_the_frontend_sends_and_this_version_cannot_place_costs_only_itself() {
        let sent = Settings::sent(&serde_json::json!({
            "ui": { "language": "en" },
            "annotate": { "highlightColor": "#ffd54a" },
            "watermark": { "fontFamily": "sans", "rotation": -30, "spacing": 54 },
            "pageNumbers": null,
        }));

        assert_eq!(sent.ui.and_then(|ui| ui.language).as_deref(), Some("en"));
        assert_eq!(
            sent.annotate
                .and_then(|annotate| annotate.highlight_color)
                .as_deref(),
            Some("#ffd54a")
        );
        assert!(sent.watermark.is_none());
        assert!(sent.page_numbers.is_none());
    }

    #[test]
    fn an_unreadable_section_costs_only_itself() {
        let settings = Settings::parse(
            r#"
            [ui]
            language = "en"

            [pageNumbers]
            mode = "triple"
            "#,
        );

        assert_eq!(
            settings.ui.and_then(|ui| ui.language).as_deref(),
            Some("en")
        );
        assert!(settings.page_numbers.is_none());
    }

    #[test]
    fn an_unreadable_file_reads_as_unset() {
        let settings = Settings::parse("{ not toml");

        assert!(settings.ui.is_none());
        assert!(settings.page_numbers.is_none());
    }

    #[test]
    fn adopts_the_style_the_replaced_file_held() {
        assert_eq!(
            replaced_page_numbers(
                r#"{"pageNumbers":{"mode":"duplex","position":"bottomRight",
                "smartColor":false,"blankNumbered":false,"blankCounted":true}}"#
            ),
            Some(page_numbers())
        );
        // Missing, malformed, and holding a value outside the schema.
        assert!(replaced_page_numbers("{}").is_none());
        assert!(replaced_page_numbers("{ not json").is_none());
        assert!(replaced_page_numbers(r#"{"pageNumbers":{"mode":"triple"}}"#).is_none());
    }
}
