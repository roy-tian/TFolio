use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use allsorts::{
    binary::read::ReadScope,
    font::{Font, MatchingPresentation},
    font_data::FontData,
    subset::{subset, CmapTarget, SubsetProfile},
    tables::Fixed,
    variations::instance,
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub(super) const CJK_FONT_NAME: &str = "NotoSansSC.ttf";
/// The page-number serif face. Already instanced to Regular and cut to the
/// digit/dash glyphs by `download-fonts.mjs`, so — unlike the sans face — it is
/// embedded whole rather than subset again at runtime.
pub(super) const SERIF_CJK_FONT_NAME: &str = "NotoSerifSC.ttf";
const CJK_REGULAR_FONT_WEIGHT: i32 = 400;

/// One of the standard fonts a note may be set in.
///
/// Resolved from the caller's string before any work is done, so an unknown one
/// is refused up front rather than after a font has been read and subset — and
/// so it is refused on *both* paths: text that carries its own embedded face
/// never reaches the standard fonts, and would otherwise take any family string
/// at all.
pub(super) enum StandardFace {
    Sans,
    Serif,
    Mono,
}

pub(super) fn standard_face(name: &str) -> Option<StandardFace> {
    match name {
        "sans" => Some(StandardFace::Sans),
        "serif" => Some(StandardFace::Serif),
        "mono" => Some(StandardFace::Mono),
        _ => None,
    }
}

/// Whether `text` needs the bundled font embedded, or one of PDFium's standard
/// 14 can already draw it.
///
/// The question asked is "can the standard fonts encode this", not "is this
/// CJK". They are keyed by WinAnsi, so the answer is Latin-1's printable range
/// and nothing else — and phrasing it that way means Cyrillic, kana, hangul and
/// anything else outside it embed a font too, rather than silently rendering as
/// gaps because a list of CJK blocks did not happen to mention them.
pub(super) fn needs_embedded_font(text: &str) -> bool {
    text.chars()
        .any(|character| !matches!(character, ' '..='~' | '\u{a0}'..='\u{ff}' | '\n' | '\r'))
}

/// Where the bundled sans CJK font is.
pub(super) fn cjk_font_path(app: &AppHandle) -> Option<PathBuf> {
    font_path(app, CJK_FONT_NAME)
}

/// Where the bundled serif CJK font — the page-number face — is.
pub(super) fn serif_cjk_font_path(app: &AppHandle) -> Option<PathBuf> {
    font_path(app, SERIF_CJK_FONT_NAME)
}

/// Where a bundled font `name` is, searched the way `bind_pdfium` searches for
/// the PDFium library so a dev build, a test and a bundle all find it. A
/// `TFOLIO_FONT_PATH` directory overrides the search for every font; a file
/// there overrides only the one whose name it carries, so pointing it at one
/// face does not hide the others.
fn font_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("TFOLIO_FONT_PATH") {
        let path = PathBuf::from(path);

        if path.is_dir() {
            candidates.push(path.join(name));
        } else if path.file_name().is_some_and(|file| file == name) {
            candidates.push(path);
        }
    }

    if let Ok(resource_path) = app
        .path()
        .resolve(Path::new("fonts").join(name), BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    candidates.push(bundled_font_path(name));
    candidates.into_iter().find(|path| path.is_file())
}

/// A bundled font in the source tree, which is where a dev build and the tests
/// read it from — `bun run fonts:download` puts it there.
pub(super) fn bundled_font_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("fonts")
        .join(name)
}

/// Resolves the bundled variable face to a static instance PDFium can embed.
/// The source font's `wght` axis defaults to 100, and PDFium exposes no
/// variation-axis selection when loading a font from bytes, so every requested
/// weight has to be resolved before the text's glyph subset is taken.
fn cjk_font_at_weight(font_bytes: &[u8], weight: i32) -> Result<Vec<u8>, String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the bundled font could not be read: {error}"))?;
    let provider = font_data
        .table_provider(0)
        .map_err(|error| format!("the bundled font has no usable tables: {error}"))?;

    instance(&provider, &[Fixed::from(weight)])
        .map(|(bytes, _)| bytes)
        .map_err(|error| format!("the bundled font could not select weight {weight}: {error}"))
}

pub(super) fn regular_cjk_font(font_bytes: &[u8]) -> Result<Vec<u8>, String> {
    cjk_font_at_weight(font_bytes, CJK_REGULAR_FONT_WEIGHT)
}

/// Cuts `font_bytes` down to just the glyphs `text` uses.
///
/// Per note rather than per document: PDFium binds a text object to its font as
/// the object is created, and 0.9.3 exposes no way to point an existing one at a
/// different font afterwards, so a note cannot join a subset grown later for
/// another. Repeated glyphs across notes cost a few KB, against the ~17 MB
/// PDFium would otherwise embed verbatim — it does not subset anything itself.
///
/// The subset must keep a `cmap`. PDFium maps characters to glyphs through it,
/// and a subset without one is accepted, embedded, saved, and drawn as a row of
/// empty boxes — which is why `CmapTarget::Unicode` is named explicitly here.
pub(super) fn subset_for(font_bytes: &[u8], text: &str) -> Result<Vec<u8>, String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the bundled font could not be read: {error}"))?;
    let provider = font_data
        .table_provider(0)
        .map_err(|error| format!("the bundled font has no usable tables: {error}"))?;
    let lookup_provider = font_data
        .table_provider(0)
        .map_err(|error| format!("the bundled font has no usable tables: {error}"))?;
    let mut font = Font::new(lookup_provider)
        .map_err(|error| format!("the bundled font could not be parsed: {error}"))?;

    // Glyph 0 is `.notdef` and allsorts requires it first and unrepeated. The
    // rest keep the order they were met in, so a subset is a function of the
    // note's text alone.
    let mut glyphs = vec![0u16];
    let mut seen = HashSet::from([0u16]);

    for character in text.chars() {
        let (glyph, _) =
            font.lookup_glyph_index(character, MatchingPresentation::NotRequired, None);

        // A character the font does not cover maps to `.notdef`, already present.
        if seen.insert(glyph) {
            glyphs.push(glyph);
        }
    }

    subset(&provider, &glyphs, &SubsetProfile::Pdf, CmapTarget::Unicode)
        .map_err(|error| format!("the bundled font could not be subset: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use allsorts::{
        tables::{os2::Os2, FontTableProvider},
        tag,
    };

    #[test]
    fn latin_text_needs_no_embedded_font() {
        assert!(!needs_embedded_font("Hello, world!"));
        assert!(!needs_embedded_font("Line one\nLine two"));
        // Latin-1's own accents are WinAnsi's too, so a French note stays free.
        assert!(!needs_embedded_font("Voilà, café"));
        assert!(!needs_embedded_font("Grüße"));
    }

    #[test]
    #[ignore = "requires `bun run fonts:download`"]
    fn bundled_cjk_font_resolves_its_regular_weight() {
        let source =
            std::fs::read(bundled_font_path(CJK_FONT_NAME)).expect("read bundled CJK font");

        let instance = regular_cjk_font(&source).expect("create Regular font instance");
        let font_data = ReadScope::new(&instance)
            .read::<FontData<'_>>()
            .expect("read static font instance");
        let provider = font_data
            .table_provider(0)
            .expect("read static font tables");
        let os2_data = provider
            .read_table_data(tag::OS_2)
            .expect("read static OS/2 table");
        let os2 = ReadScope::new(&os2_data)
            .read_dep::<Os2>(os2_data.len())
            .expect("parse static OS/2 table");

        assert_eq!(os2.us_weight_class, CJK_REGULAR_FONT_WEIGHT as u16);
        assert!(provider
            .table_data(tag::FVAR)
            .expect("inspect static variation table")
            .is_none());

        let subset = subset_for(&instance, "水印").expect("subset static font instance");
        ReadScope::new(&subset)
            .read::<FontData<'_>>()
            .expect("read static font subset");
    }

    #[test]
    fn text_outside_latin_1_needs_an_embedded_font() {
        assert!(needs_embedded_font("你好"));
        assert!(needs_embedded_font("Hello 你好"));
        assert!(needs_embedded_font("，"));
        // Not CJK, and just as unrenderable by the standard 14.
        assert!(needs_embedded_font("Привет"));
        assert!(needs_embedded_font("こんにちは"));
        assert!(needs_embedded_font("안녕"));
        // An em dash is outside Latin-1 even though it reads as Western text.
        assert!(needs_embedded_font("a — b"));
    }

    #[test]
    fn an_empty_note_needs_no_embedded_font() {
        assert!(!needs_embedded_font(""));
    }
}
