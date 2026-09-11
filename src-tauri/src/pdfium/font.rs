use std::{
    collections::HashSet,
    env,
    fmt::Write,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use allsorts::{
    binary::read::ReadScope,
    font::{Font, MatchingPresentation},
    font_data::FontData,
    subset::{subset, CmapTarget, SubsetProfile},
    tables::{os2::Os2, variable_fonts::fvar::FvarTable, Fixed, FontTableProvider},
    tag,
    variations::{instance, VariationError},
};
use fontdb::{Database, Family, Query, Source, Stretch, Style, Weight};
use sha2::{Digest, Sha256};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub(super) const CJK_FONT_NAME: &str = "NotoSansSC.ttf";
/// Body text is Regular: a variable face left unpinned embeds wherever its own
/// axes default to — Thin, for the fetched fallback.
const REGULAR_FONT_WEIGHT: i32 = 400;

/// A wire value the frontend matches verbatim (`NOTE_FONT_MISSING` in
/// `src/lib/annotationStyles.ts`), not a message.
pub(super) const FONT_MISSING_ERROR: &str = "tfolio:font-missing";

/// A commit rather than a branch, plus the size and digest the bytes must
/// have: these bytes go on to be embedded in readers' own documents.
const FALLBACK_FONT_COMMIT: &str = "2894aab31764f10f29c421bdfd2340d3b382d384";
const FALLBACK_FONT_SOURCE: &str = "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf";
const FALLBACK_FONT_BYTES: usize = 17772300;
const FALLBACK_FONT_SHA256: &str =
    "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da";
/// Compiled in so the licence cannot fail to arrive or differ from the pinned
/// commit; it sits outside `resources/fonts/`, which the download script sweeps.
const FALLBACK_FONT_LICENSE: &str = include_str!("../../resources/OFL.NotoSansSC.txt");
const FALLBACK_FONT_LICENSE_NAME: &str = "LICENSE.NotoSansSC";
/// Generous — 17 MB over a slow line is not a failure — but finite, so a
/// connection that opens and then stalls cannot spin for ever.
const FETCH_TIMEOUT: Duration = Duration::from_secs(300);

const EMBEDDED_FAMILIES: &[&str] = &[
    "Microsoft YaHei",
    "微软雅黑",
    "Microsoft JhengHei",
    "微軟正黑體",
    "PingFang SC",
    "苹方-简",
    "Hiragino Sans GB",
    "冬青黑体简体中文",
    "Heiti SC",
    "STHeiti",
    "华文黑体",
    "Noto Sans SC",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "思源黑体",
    "WenQuanYi Zen Hei",
    "文泉驿正黑",
    "WenQuanYi Micro Hei",
    "Droid Sans Fallback",
];

/// `Family::SansSerif` could answer with a Latin-only face and draw every note
/// as boxes; the probe rejects a candidate that cannot draw these two characters.
pub(super) const EMBEDDED_FACE_PROBE: &str = "汉字";

pub(super) const PAGE_NUMBER_GLYPHS: &str = "0123456789— ";

const PAGE_NUMBER_FAMILIES: &[&str] = &[
    "SimSun",
    "宋体",
    "NSimSun",
    "新宋体",
    "Songti SC",
    "宋体-简",
    "STSong",
    "华文宋体",
    "Songti TC",
    "Noto Serif CJK SC",
    "Source Han Serif SC",
    "思源宋体",
    "AR PL UMing CN",
    "AR PL SungtiL GB",
    "Noto Serif",
    "Liberation Serif",
    "Times New Roman",
    "DejaVu Serif",
    "FreeSerif",
];

/// `fsType` bits — restricted licence, no subsetting, bitmap-only — that forbid
/// an embedded subset; the permission is the font's own to give.
const EMBEDDING_FORBIDDEN: u16 = 0x0002 | 0x0100 | 0x0200;

/// Asks "can the standard 14 encode this" — they are WinAnsi-keyed — rather
/// than "is this CJK", so anything outside Latin-1 embeds instead of drawing gaps.
pub(super) fn needs_embedded_font(text: &str) -> bool {
    text.chars()
        .any(|character| !matches!(character, ' '..='~' | '\u{a0}'..='\u{ff}' | '\n' | '\r'))
}

/// Existence is deliberately not checked: the fallback arrives only when a
/// reader accepts the download.
pub(super) fn fallback_font_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("TFOLIO_FONT_PATH") {
        let path = PathBuf::from(path);

        if path.is_dir() {
            candidates.push(path.join(CJK_FONT_NAME));
        } else if path.file_name().is_some_and(|file| file == CJK_FONT_NAME) {
            candidates.push(path);
        }
    }

    if let Some(downloaded) = fallback_font_destination(app) {
        candidates.push(downloaded);
    }

    if let Ok(resource_path) = app.path().resolve(
        Path::new("fonts").join(CJK_FONT_NAME),
        BaseDirectory::Resource,
    ) {
        candidates.push(resource_path);
    }

    candidates.push(bundled_font_path(CJK_FONT_NAME));
    candidates
}

/// The app's own data directory, not the resource directory: an `.app` bundle
/// or `/usr` install is read-only, and where it is not, the bundle is signed.
pub(super) fn fallback_font_destination(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join("fonts").join(CJK_FONT_NAME))
}

pub(super) fn bundled_font_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("fonts")
        .join(name)
}

/// Rebuilt per walk rather than held: a caller keeps the face a walk found,
/// not the scan that found it.
fn installed_faces() -> Database {
    let mut database = Database::new();
    database.load_system_fonts();
    database
}

fn first_usable_face<T>(
    library: &Database,
    families: &[&str],
    generics: &[Family<'static>],
    mut accept: impl FnMut(&[u8], usize) -> Option<T>,
) -> Option<T> {
    let candidates: Vec<Family<'_>> = families
        .iter()
        .map(|name| Family::Name(name))
        .chain(generics.iter().copied())
        .collect();

    for family in candidates {
        let Some(id) = library.query(&Query {
            families: &[family],
            weight: Weight::NORMAL,
            stretch: Stretch::Normal,
            style: Style::Normal,
        }) else {
            continue;
        };
        let Some((source, index)) = library.face_source(id) else {
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

        if let Some(accepted) = accept(&bytes, index as usize) {
            return Some(accepted);
        }
    }

    None
}

/// `None` is the ordinary answer where the only CJK face is PostScript-flavoured
/// (Noto Sans CJK, PingFang) — that is what the downloadable fallback is for.
pub(super) fn system_embedded_face(probe: &str) -> Option<(Vec<u8>, usize)> {
    embedded_face(&installed_faces(), probe)
}

fn embedded_face(library: &Database, probe: &str) -> Option<(Vec<u8>, usize)> {
    first_usable_face(
        library,
        EMBEDDED_FAMILIES,
        &[Family::SansSerif],
        |bytes, index| embedded_candidate(bytes, index, probe),
    )
}

fn embedded_candidate(font_bytes: &[u8], index: usize, probe: &str) -> Option<(Vec<u8>, usize)> {
    embeddable_face(font_bytes, index).ok()?;

    // Pinned before it is judged: the probe must test the very bytes an embed
    // would carry.
    let (bytes, index) = regular_face(font_bytes, index).ok()?;

    // Subsetting the probe is the coverage check itself: it reads the same
    // tables an embed would and fails the same way.
    subset_face(&bytes, index, probe, true).ok()?;

    Some((bytes, index))
}

/// TrueType outlines are the only shape `load_true_type_from_bytes` writes
/// correctly, and the licence is the face's own `fsType`.
fn embeddable_face(font_bytes: &[u8], index: usize) -> Result<(), String> {
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

    Ok(())
}

/// Lowercase with leading zeros, the way the pinned digest above is written.
fn hex(digest: &[u8]) -> String {
    digest.iter().fold(
        String::with_capacity(digest.len() * 2),
        |mut rendered, byte| {
            let _ = write!(rendered, "{byte:02x}");
            rendered
        },
    )
}

/// Verified against the pinned size and digest before anything is written, and
/// landed through a temporary sibling, so a failed fetch leaves no file behind.
pub(super) async fn download_fallback_font(destination: &Path) -> Result<(), String> {
    let url = format!(
        "https://cdn.jsdelivr.net/gh/google/fonts@{FALLBACK_FONT_COMMIT}/{FALLBACK_FONT_SOURCE}"
    );
    let response = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("the font could not be fetched: {error}"))?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("the font could not be fetched: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "the font could not be fetched: HTTP {}",
            response.status()
        ));
    }

    // Refused on the declared length before the body is buffered; one that lies
    // about its length is caught by the same check after it.
    if response
        .content_length()
        .is_some_and(|length| length != FALLBACK_FONT_BYTES as u64)
    {
        return Err("the font's size is not the one this app expects".into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("the font could not be read: {error}"))?;

    if bytes.len() != FALLBACK_FONT_BYTES {
        return Err("the font's size is not the one this app expects".into());
    }

    let digest = hex(&Sha256::digest(&bytes));

    if digest != FALLBACK_FONT_SHA256 {
        return Err("the font's checksum is not the one this app expects".into());
    }

    let directory = destination
        .parent()
        .ok_or_else(|| "the font has nowhere to be written".to_string())?;

    fs::create_dir_all(directory)
        .map_err(|error| format!("could not make room for the font: {error}"))?;
    fs::write(
        directory.join(FALLBACK_FONT_LICENSE_NAME),
        FALLBACK_FONT_LICENSE,
    )
    .map_err(|error| format!("the font's licence could not be written: {error}"))?;

    // Named apart per attempt: two racing fetches would otherwise interleave
    // into one file and rename the result into place.
    let suffix = getrandom::u64().map_err(|error| format!("could not name a download: {error}"))?;
    let temporary = directory.join(format!(".{CJK_FONT_NAME}.{suffix:016x}.download"));

    fs::write(&temporary, &bytes)
        .map_err(|error| format!("the font could not be written: {error}"))?;
    fs::rename(&temporary, destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);

        format!("the font could not be put in place: {error}")
    })
}

/// The generic serif closes the chain with the sans behind it, so a host with
/// no serif of its own still numbers its pages rather than needing a fetch.
pub(super) fn page_number_face() -> Result<Vec<u8>, String> {
    first_usable_face(
        &installed_faces(),
        PAGE_NUMBER_FAMILIES,
        &[Family::Serif, Family::SansSerif],
        |bytes, index| page_number_subset(bytes, index).ok(),
    )
    .ok_or_else(|| {
        "no installed font can draw page numbers; install a serif font such as \
         SimSun, Songti SC or Noto Serif"
            .into()
    })
}

fn page_number_subset(font_bytes: &[u8], index: usize) -> Result<Vec<u8>, String> {
    embeddable_face(font_bytes, index)?;

    let (bytes, index) = regular_face(font_bytes, index)?;

    subset_face(&bytes, index, PAGE_NUMBER_GLYPHS, true)
}

/// PDFium selects no axis position when loading from bytes, so variable faces
/// are resolved to Regular here; a resolved face is its own font, at index 0.
pub(super) fn regular_face(font_bytes: &[u8], index: usize) -> Result<(Vec<u8>, usize), String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the face could not be read: {error}"))?;
    let provider = font_data
        .table_provider(index)
        .map_err(|error| format!("the face has no usable tables: {error}"))?;
    let Some(fvar_data) = provider
        .table_data(tag::FVAR)
        .map_err(|error| format!("the face's variations could not be read: {error}"))?
    else {
        return Ok((font_bytes.to_vec(), index));
    };
    let fvar = ReadScope::new(&fvar_data)
        .read::<FvarTable<'_>>()
        .map_err(|error| format!("the face's variations could not be parsed: {error}"))?;

    let position: Vec<Fixed> = fvar
        .axes()
        .map(|axis| {
            if axis.axis_tag == tag::WGHT {
                Fixed::from(REGULAR_FONT_WEIGHT)
            } else {
                axis.default_value
            }
        })
        .collect();

    match instance(&provider, &position) {
        Ok((bytes, _)) => Ok((bytes, 0)),
        // Axes but no `gvar` (allsorts cites COLRv1): the outlines do not vary,
        // so the face's own bytes already are the instance.
        Err(VariationError::NotImplemented) => Ok((font_bytes.to_vec(), index)),
        Err(error) => Err(format!("the face could not be pinned to Regular: {error}")),
    }
}

/// Cut per note: PDFium 0.9.3 cannot point an existing text object at a new
/// font. `CmapTarget::Unicode` keeps the `cmap`, without which a subset draws boxes.
pub(super) fn subset_for(font_bytes: &[u8], index: usize, text: &str) -> Result<Vec<u8>, String> {
    subset_face(font_bytes, index, text, false)
}

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

    // allsorts requires `.notdef` first and unrepeated; the rest keep first-met
    // order so a subset is a function of the text alone.
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
            std::fs::read(bundled_font_path(CJK_FONT_NAME)).expect("read the fallback CJK font");

        let (instance, index) = regular_face(&source, 0).expect("create Regular font instance");

        assert_eq!(index, 0, "a resolved instance is a font of its own");

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

        assert_eq!(os2.us_weight_class, REGULAR_FONT_WEIGHT as u16);
        assert!(provider
            .table_data(tag::FVAR)
            .expect("inspect static variation table")
            .is_none());

        let subset = subset_for(&instance, 0, "水印").expect("subset static font instance");
        ReadScope::new(&subset)
            .read::<FontData<'_>>()
            .expect("read static font subset");

        // A subset is static, and a static face is already the instance it
        // would resolve to — the other half of what `regular_face` promises.
        let (resolved, index) = regular_face(&subset, 0).expect("resolve a static face");

        assert_eq!(index, 0);
        assert_eq!(resolved, subset, "a static face should come back untouched");
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
    fn the_system_face_is_embeddable_and_draws_the_probe() {
        // A machine with no embeddable CJK sans is a real answer, not a failed
        // test — it is the case the downloadable fallback exists for.
        let Some((bytes, index)) = system_embedded_face(EMBEDDED_FACE_PROBE) else {
            return;
        };

        embeddable_face(&bytes, index).expect("the resolved face should be embeddable");

        let subset = subset_face(&bytes, index, EMBEDDED_FACE_PROBE, true)
            .expect("the resolved face should draw the probe");
        let font_data = ReadScope::new(&subset)
            .read::<FontData<'_>>()
            .expect("read the resolved subset");

        // A subset is a font of its own, so PDFium reads it at index 0 — and it
        // has to still be the TrueType flavour the embed call promises.
        assert!(font_data
            .table_provider(0)
            .expect("read the resolved subset's tables")
            .table_data(tag::GLYF)
            .expect("inspect the subset's outlines")
            .is_some());
    }

    // The test above asserts nothing on a machine with no Chinese fonts, which
    // is how this chain went unasserted in CI; here the library holds one file.
    #[test]
    #[ignore = "requires `bun run fonts:download`"]
    fn the_embedded_chain_resolves_the_face_it_is_given() {
        let mut library = Database::new();
        library
            .load_font_file(bundled_font_path(CJK_FONT_NAME))
            .expect("load the face `bun run fonts:download` wrote");

        // Nothing generic can answer a one-file library, so this also holds
        // `EMBEDDED_FAMILIES` to naming the family the face calls itself.
        let (bytes, index) = embedded_face(&library, EMBEDDED_FACE_PROBE)
            .expect("the chain should accept the pinned Noto Sans SC");

        assert_eq!(index, 0, "a resolved instance is a font of its own");

        let font_data = ReadScope::new(&bytes)
            .read::<FontData<'_>>()
            .expect("read the resolved face");
        let provider = font_data
            .table_provider(index)
            .expect("read the resolved face's tables");

        assert!(
            provider
                .table_data(tag::GLYF)
                .expect("inspect the resolved face's outlines")
                .is_some(),
            "the chain should hand back the TrueType flavour the embed promises"
        );

        assert!(
            provider
                .table_data(tag::FVAR)
                .expect("inspect the resolved face's variations")
                .is_none(),
            "the chain should hand back a face with no axes left to place"
        );

        let os2_data = provider
            .read_table_data(tag::OS_2)
            .expect("read the resolved face's OS/2 table");
        let os2 = ReadScope::new(&os2_data)
            .read_dep::<Os2>(os2_data.len())
            .expect("parse the resolved face's OS/2 table");

        assert_eq!(
            os2.us_weight_class, REGULAR_FONT_WEIGHT as u16,
            "an embedded run is body text, not Thin"
        );

        subset_face(&bytes, index, EMBEDDED_FACE_PROBE, true)
            .expect("the resolved face should still draw the probe");
    }

    #[test]
    fn a_digest_renders_the_way_the_pin_is_written() {
        // The pin is compared as text, so a byte rendered without its leading
        // zero would quietly widen what the fetch accepts.
        assert_eq!(
            hex(&Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }

    #[test]
    fn the_fetched_pin_matches_the_download_script() {
        // The bytes are pinned twice — here and in `download-fonts.mjs` — and
        // nothing else would notice one being bumped while the other stayed put.
        let script = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("scripts")
                .join("download-fonts.mjs"),
        )
        .expect("read the font download script");

        for pin in [
            FALLBACK_FONT_COMMIT,
            FALLBACK_FONT_SOURCE,
            FALLBACK_FONT_SHA256,
            FALLBACK_FONT_LICENSE_NAME,
            CJK_FONT_NAME,
            &FALLBACK_FONT_BYTES.to_string(),
        ] {
            assert!(script.contains(pin), "the script no longer pins {pin}");
        }
    }

    #[test]
    #[ignore = "requires `bun run fonts:download`"]
    fn the_compiled_in_licence_matches_the_fetched_face() {
        // The licence is compiled in while the face is fetched; only the
        // script's own copy from the pinned commit can hold this text to it.
        let fetched = fs::read_to_string(
            bundled_font_path(CJK_FONT_NAME).with_file_name(FALLBACK_FONT_LICENSE_NAME),
        )
        .expect("read the licence `bun run fonts:download` wrote");

        assert_eq!(
            FALLBACK_FONT_LICENSE, fetched,
            "the compiled-in licence has drifted from the pinned commit's own"
        );
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
