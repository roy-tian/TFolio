use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use allsorts::{
    binary::read::ReadScope,
    font::{Font, MatchingPresentation},
    font_data::FontData,
    subset::{subset, CmapTarget, SubsetProfile},
    tables::{os2::Os2, Fixed, FontTableProvider},
    tag,
    variations::instance,
};
use fontdb::{Database, Family, Query, Source, Stretch, Style, Weight};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub(super) const CJK_FONT_NAME: &str = "NotoSansSC.ttf";
const CJK_REGULAR_FONT_WEIGHT: i32 = 400;

/// Every glyph a page-number label can carry: the ten digits, the em dash it
/// wraps them in, and the space between. A face that misses one of them is not
/// the page-number face, whatever its name.
pub(super) const PAGE_NUMBER_GLYPHS: &str = "0123456789— ";

/// The page-number face, tried in this order — the reader's own 宋体 first, then
/// each platform's nearest Songti, then any serif at all. Nothing is bundled:
/// the label is ten digits and a dash, which every desktop can already draw,
/// and a Chinese system draws them in the face a Chinese document expects.
///
/// Localized family names are matched too, so a Chinese Windows that only calls
/// the face 宋体 is found by the same list as an English one.
const PAGE_NUMBER_FAMILIES: &[&str] = &[
    // Windows
    "SimSun",
    "宋体",
    "NSimSun",
    "新宋体",
    // macOS
    "Songti SC",
    "宋体-简",
    "STSong",
    "华文宋体",
    "Songti TC",
    // Linux distributions, where a Songti is a package rather than a given
    "Noto Serif CJK SC",
    "Source Han Serif SC",
    "思源宋体",
    "AR PL UMing CN",
    "AR PL SungtiL GB",
    // Any serif, since what is left to draw is Latin digits and a dash
    "Noto Serif",
    "Liberation Serif",
    "Times New Roman",
    "DejaVu Serif",
    "FreeSerif",
];

/// Bits of the OS/2 `fsType` that forbid what embedding a subset in a PDF does:
/// restricted licence (0x0002), no subsetting (0x0100), and bitmap-only
/// embedding (0x0200). A face that sets one is skipped for the next candidate —
/// this app puts other people's fonts inside the reader's documents, and the
/// font itself is where that permission is recorded.
const EMBEDDING_FORBIDDEN: u16 = 0x0002 | 0x0100 | 0x0200;

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

/// The page-number face as bytes PDFium can embed: the first family in the
/// chain the system actually has, cut to the label's dozen glyphs.
///
/// Every candidate is held to what this use needs — TrueType outlines, since
/// that is the only shape `load_true_type_from_bytes` describes correctly in the
/// PDF it writes; every label glyph present, so no page prints a row of boxes;
/// and an `fsType` that permits an embedded subset. A face that fails any of
/// them is not an error, just the wrong candidate: the walk carries on.
pub(super) fn page_number_face() -> Result<Vec<u8>, String> {
    let mut database = Database::new();
    database.load_system_fonts();

    // The generic serif closes the chain: fontconfig, or the platform's own
    // default, names a face the reader already reads text in.
    let families: Vec<Family<'_>> = PAGE_NUMBER_FAMILIES
        .iter()
        .map(|name| Family::Name(name))
        .chain([Family::Serif])
        .collect();

    for family in families {
        let Some(id) = database.query(&Query {
            families: &[family],
            weight: Weight::NORMAL,
            stretch: Stretch::Normal,
            style: Style::Normal,
        }) else {
            continue;
        };
        let Some((source, index)) = database.face_source(id) else {
            continue;
        };
        let bytes = match source {
            Source::File(path) => match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            },
            Source::Binary(data) => data.as_ref().as_ref().to_vec(),
            Source::SharedFile(_, data) => data.as_ref().as_ref().to_vec(),
        };

        if let Ok(subset) = page_number_subset(&bytes, index as usize) {
            return Ok(subset);
        }
    }

    Err(
        "no installed font can draw page numbers; install a serif font such as \
         SimSun, Songti SC or Noto Serif"
            .into(),
    )
}

/// One candidate face, checked and cut, or the reason it is not usable.
fn page_number_subset(font_bytes: &[u8], index: usize) -> Result<Vec<u8>, String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the face could not be read: {error}"))?;
    let provider = font_data
        .table_provider(index)
        .map_err(|error| format!("the face has no usable tables: {error}"))?;

    if provider
        .table_data(tag::GLYF)
        .map_err(|error| format!("the face's outlines could not be read: {error}"))?
        .is_none()
    {
        return Err("the face has no TrueType outlines".into());
    }

    let os2_data = provider
        .read_table_data(tag::OS_2)
        .map_err(|error| format!("the face has no OS/2 table: {error}"))?;
    let os2 = ReadScope::new(&os2_data)
        .read_dep::<Os2>(os2_data.len())
        .map_err(|error| format!("the face's OS/2 table could not be parsed: {error}"))?;

    if os2.fs_type & EMBEDDING_FORBIDDEN != 0 {
        return Err("the face's licence forbids embedding a subset".into());
    }

    subset_face(font_bytes, index, PAGE_NUMBER_GLYPHS, true)
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
    subset_face(font_bytes, 0, text, false)
}

/// Cuts one face of `font_bytes` — a plain font or a collection member — down to
/// just the glyphs `text` uses.
///
/// `require_coverage` refuses a face that would draw any of them as `.notdef`.
/// The page-number chain asks for it, having a next candidate to try; a note's
/// own text has none, and takes what the bundled face happens to hold.
fn subset_face(
    font_bytes: &[u8],
    index: usize,
    text: &str,
    require_coverage: bool,
) -> Result<Vec<u8>, String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the font could not be read: {error}"))?;
    let provider = font_data
        .table_provider(index)
        .map_err(|error| format!("the font has no usable tables: {error}"))?;
    let lookup_provider = font_data
        .table_provider(index)
        .map_err(|error| format!("the font has no usable tables: {error}"))?;
    let mut font = Font::new(lookup_provider)
        .map_err(|error| format!("the font could not be parsed: {error}"))?;

    // Glyph 0 is `.notdef` and allsorts requires it first and unrepeated. The
    // rest keep the order they were met in, so a subset is a function of the
    // note's text alone.
    let mut glyphs = vec![0u16];
    let mut seen = HashSet::from([0u16]);

    for character in text.chars() {
        let (glyph, _) =
            font.lookup_glyph_index(character, MatchingPresentation::NotRequired, None);

        if require_coverage && glyph == 0 {
            return Err(format!("the face cannot draw {character:?}"));
        }

        // A character the font does not cover maps to `.notdef`, already present.
        if seen.insert(glyph) {
            glyphs.push(glyph);
        }
    }

    subset(&provider, &glyphs, &SubsetProfile::Pdf, CmapTarget::Unicode)
        .map_err(|error| format!("the font could not be subset: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn the_page_number_face_is_embeddable_and_covers_the_label() {
        // A machine with no font at all is a real answer, not a failed test —
        // what is asserted here is what the chain hands back when it finds one.
        let Ok(face) = page_number_face() else {
            return;
        };

        let font_data = ReadScope::new(&face)
            .read::<FontData<'_>>()
            .expect("read the resolved face");
        let provider = font_data
            .table_provider(0)
            .expect("read the resolved face's tables");

        // A subset is a font of its own, so PDFium reads it at index 0 — and it
        // has to still be the TrueType flavour the embed call promises.
        assert!(provider
            .table_data(tag::GLYF)
            .expect("inspect the subset's outlines")
            .is_some());

        let mut font = Font::new(
            font_data
                .table_provider(0)
                .expect("read the resolved face's tables"),
        )
        .expect("parse the resolved face");

        for character in PAGE_NUMBER_GLYPHS.chars() {
            let (glyph, _) =
                font.lookup_glyph_index(character, MatchingPresentation::NotRequired, None);

            assert_ne!(glyph, 0, "the subset should still draw {character:?}");
        }
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
