use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
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
use sha2::{Digest, Sha256};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub(super) const CJK_FONT_NAME: &str = "NotoSansSC.ttf";
const CJK_REGULAR_FONT_WEIGHT: i32 = 400;

/// The error a caller gets when nothing on this machine can draw the text and
/// no fallback face has been fetched yet. Matched verbatim by the frontend,
/// which turns it into the offer to download one — so it is a wire value, not
/// a message, and changing it means changing `NOTE_FONT_MISSING` in
/// `src/lib/annotationStyles.ts` too.
pub(super) const FONT_MISSING_ERROR: &str = "tfolio:font-missing";

/// Where the fallback face is fetched from, pinned exactly as
/// `scripts/download-fonts.mjs` pins it: a commit rather than a branch, and the
/// size and digest the bytes must have. A face that fails either check is not
/// written — these bytes go on to be embedded in the reader's own documents.
const FALLBACK_FONT_COMMIT: &str = "2894aab31764f10f29c421bdfd2340d3b382d384";
const FALLBACK_FONT_SOURCE: &str = "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf";
const FALLBACK_FONT_BYTES: usize = 17772300;
const FALLBACK_FONT_SHA256: &str =
    "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da";
/// The face is OFL, which asks that the licence travel with it. It used to
/// travel as a bundled resource; now that the face is fetched, its licence is
/// fetched with it and written beside it — and, since it is not pinned by
/// digest, bounded, because an unpinned response is not a known length.
const FALLBACK_FONT_LICENSE_SOURCE: &str = "ofl/notosanssc/OFL.txt";
const FALLBACK_FONT_LICENSE_NAME: &str = "LICENSE.NotoSansSC";
const MAX_FALLBACK_FONT_LICENSE_BYTES: usize = 64 * 1024;
/// How long a fetch may take before it is given up on. Generous, because 17 MB
/// over a slow line is not a failure, but finite: without it a connection that
/// opens and then stalls leaves the reader watching a button spin for ever,
/// with nothing to press and nothing to read.
const FETCH_TIMEOUT: Duration = Duration::from_secs(300);

/// The sans face an embedded run is drawn in, tried in this order — each
/// platform's own default Chinese sans first, then the faces a Linux
/// distribution is likely to have, then any sans at all.
///
/// Localized family names are matched too, so a Chinese Windows that only calls
/// the face 微软雅黑 is found by the same list as an English one.
const EMBEDDED_FAMILIES: &[&str] = &[
    // Windows
    "Microsoft YaHei",
    "微软雅黑",
    "Microsoft JhengHei",
    "微軟正黑體",
    // macOS. PingFang leads because it is the system face; whether it can
    // actually be embedded is decided by the checks below, not by this order.
    "PingFang SC",
    "苹方-简",
    "Hiragino Sans GB",
    "冬青黑体简体中文",
    "Heiti SC",
    "STHeiti",
    "华文黑体",
    // Linux distributions, where a CJK sans is a package rather than a given
    "Noto Sans SC",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "思源黑体",
    "WenQuanYi Zen Hei",
    "文泉驿正黑",
    "WenQuanYi Micro Hei",
    "Droid Sans Fallback",
];

/// What a face has to draw to be this app's embedded face. Every candidate
/// above is a CJK sans, but `Family::SansSerif` closes the chain and a system
/// whose default sans is Latin-only would otherwise answer it — and then draw
/// every note as a row of boxes. Two characters is enough to tell them apart.
pub(super) const EMBEDDED_FACE_PROBE: &str = "汉字";

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

/// Whether `text` needs a face embedded, or one of PDFium's standard
/// 14 can already draw it.
///
/// The question asked is "can the standard fonts encode this", not "is this
/// CJK". They are keyed by WinAnsi, so the answer is Latin-1's printable range
/// and nothing else — and phrasing it that way means Cyrillic, kana, hangul and
/// anything else outside it embed a face too, rather than silently rendering as
/// gaps because a list of CJK blocks did not happen to mention them.
///
/// Text that stays inside it is drawn in Helvetica, which costs no embedded
/// bytes and every reader already has.
pub(super) fn needs_embedded_font(text: &str) -> bool {
    text.chars()
        .any(|character| !matches!(character, ' '..='~' | '\u{a0}'..='\u{ff}' | '\n' | '\r'))
}

/// Every place the fallback face may already be, in the order they are tried.
///
/// Resolved at startup because that is the only point an `AppHandle` reaches
/// this module, but *not* checked for existence there: the whole point of the
/// fallback is that it arrives later, when a reader accepts the download.
///
/// A `TFOLIO_FONT_PATH` directory overrides the search; a file there overrides
/// only the face whose name it carries. The tests take the copy
/// `bun run fonts:download` leaves in the source tree, so they never reach for
/// the network; nothing else runs that script, so a dev build takes the same
/// path a reader's does.
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

/// Where a download writes. The app's own data directory rather than the
/// resource directory, which a packaged build has no business writing to — an
/// `.app` bundle or an `/usr` install is read-only, and on the platforms where
/// it is not, writing there would put a fetched file inside the signed bundle.
pub(super) fn fallback_font_destination(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join("fonts").join(CJK_FONT_NAME))
}

/// A font in the source tree, which is where a dev build and the tests read it
/// from — `bun run fonts:download` puts it there.
pub(super) fn bundled_font_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("fonts")
        .join(name)
}

/// The first face in `families` — then `generics`, which close the chain with
/// whatever this platform calls its default — that `accept` can use.
///
/// The one walk both font chains take: read the system database, read each
/// candidate's bytes in turn, and stop at the first its caller accepts. A face
/// the caller turns down is not an error, just the wrong candidate.
fn first_usable_face<T>(
    families: &[&str],
    generics: &[Family<'static>],
    mut accept: impl FnMut(&[u8], usize) -> Option<T>,
) -> Option<T> {
    let mut database = Database::new();
    database.load_system_fonts();

    let candidates: Vec<Family<'_>> = families
        .iter()
        .map(|name| Family::Name(name))
        .chain(generics.iter().copied())
        .collect();

    for family in candidates {
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

        if let Some(accepted) = accept(&bytes, index as usize) {
            return Some(accepted);
        }
    }

    None
}

/// The system's own sans face for text the standard fonts cannot draw: the
/// bytes to subset, and the index of the face inside them.
///
/// Held to exactly what embedding needs, as the page-number chain is —
/// TrueType outlines, since `load_true_type_from_bytes` is the only shape
/// PDFium describes correctly in the PDF it writes; an `fsType` that permits an
/// embedded subset; and `probe`, every character of which the face must draw.
///
/// `probe` is `EMBEDDED_FACE_PROBE` for the answer worth caching, and the run's
/// own text on the path that would otherwise refuse it: a machine with a sans
/// that draws Cyrillic but no CJK is not a machine that can draw nothing.
///
/// `None` is the ordinary answer on a machine whose only CJK face is
/// PostScript-flavoured — Noto Sans CJK and Source Han Sans both are, and so,
/// on macOS, is PingFang. That is what the downloadable fallback is for.
pub(super) fn system_embedded_face(probe: &str) -> Option<(Vec<u8>, usize)> {
    first_usable_face(EMBEDDED_FAMILIES, &[Family::SansSerif], |bytes, index| {
        // Subsetting the probe is the whole check: it reads the same tables an
        // embed would, and fails the same way. The result is thrown away, only
        // its success is kept.
        (embeddable_face(bytes, index).is_ok() && subset_face(bytes, index, probe, true).is_ok())
            .then(|| (bytes.to_vec(), index))
    })
}

/// Whether one face of `font_bytes` may be embedded as a subset at all: the
/// outline flavour PDFium's loader promises, and the licence the face itself
/// records.
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

/// One file from the pinned commit, or the reason it did not arrive.
///
/// Takes the client rather than making one: building it reads the platform's
/// trust store, which is work neither of a download's two requests needs to do
/// twice, and it is where the timeout lives.
async fn fetch_pinned(
    client: &reqwest::Client,
    source: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let url = format!("https://cdn.jsdelivr.net/gh/google/fonts@{FALLBACK_FONT_COMMIT}/{source}");
    let response = client
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

    // Refused on the declared length before the body is buffered, so a response
    // that is not the file this app asked for costs nothing to turn away. A
    // response that lies about its length is caught by the same check below.
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("the font is larger than this app expects".into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("the font could not be read: {error}"))?;

    if bytes.len() > limit {
        return Err("the font is larger than this app expects".into());
    }

    Ok(bytes.to_vec())
}

/// Fetches the fallback face to `destination`, replacing whatever is there.
///
/// The bytes are held to the size and digest pinned above *before* anything is
/// written, so a truncated download, a captive portal's login page, or a CDN
/// serving something else leaves no file behind rather than one that fails
/// later inside a reader's document. Written through a temporary sibling and
/// renamed, so an interrupted fetch cannot leave a half file under the name the
/// next run will trust.
///
/// The licence lands first and the face last, so the face is never on disk
/// without the terms it came under.
pub(super) async fn download_fallback_font(destination: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("the font could not be fetched: {error}"))?;
    let bytes = fetch_pinned(&client, FALLBACK_FONT_SOURCE, FALLBACK_FONT_BYTES).await?;

    if bytes.len() != FALLBACK_FONT_BYTES {
        return Err("the font's size is not the one this app expects".into());
    }

    let digest = format!("{:x}", Sha256::digest(&bytes));

    if digest != FALLBACK_FONT_SHA256 {
        return Err("the font's checksum is not the one this app expects".into());
    }

    let license = fetch_pinned(
        &client,
        FALLBACK_FONT_LICENSE_SOURCE,
        MAX_FALLBACK_FONT_LICENSE_BYTES,
    )
    .await?;

    let directory = destination
        .parent()
        .ok_or_else(|| "the font has nowhere to be written".to_string())?;

    fs::create_dir_all(directory)
        .map_err(|error| format!("could not make room for the font: {error}"))?;
    fs::write(directory.join(FALLBACK_FONT_LICENSE_NAME), &license)
        .map_err(|error| format!("the font's licence could not be written: {error}"))?;

    // Named apart per attempt, as a save's temporary is: two fetches racing —
    // a double-pressed button, two windows — would otherwise interleave into
    // one file and rename the result into place.
    let suffix = getrandom::u64().map_err(|error| format!("could not name a download: {error}"))?;
    let temporary = directory.join(format!(".{CJK_FONT_NAME}.{suffix:016x}.download"));

    fs::write(&temporary, &bytes)
        .map_err(|error| format!("the font could not be written: {error}"))?;
    fs::rename(&temporary, destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);

        format!("the font could not be put in place: {error}")
    })
}

/// The page-number face as bytes PDFium can embed: the first family in the
/// chain the system actually has, cut to the label's dozen glyphs.
///
/// Every candidate is held to what this use needs — TrueType outlines, since
/// that is the only shape `load_true_type_from_bytes` describes correctly in the
/// PDF it writes; every label glyph present, so no page prints a row of boxes;
/// and an `fsType` that permits an embedded subset. A face that fails any of
/// them is not an error, just the wrong candidate: the walk carries on.
///
/// The generic serif closes the chain, and the generic sans behind it: what is
/// left to draw is ten Latin digits and a dash, so a host with no serif of its
/// own numbers its pages in whatever it does have rather than falling through
/// to a face that has to be fetched first.
pub(super) fn page_number_face() -> Result<Vec<u8>, String> {
    first_usable_face(
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

/// One candidate face, checked and cut, or the reason it is not usable.
fn page_number_subset(font_bytes: &[u8], index: usize) -> Result<Vec<u8>, String> {
    embeddable_face(font_bytes, index)?;

    subset_face(font_bytes, index, PAGE_NUMBER_GLYPHS, true)
}

/// Resolves the fallback variable face to a static instance PDFium can embed.
/// The source font's `wght` axis defaults to 100, and PDFium exposes no
/// variation-axis selection when loading a font from bytes, so every requested
/// weight has to be resolved before the text's glyph subset is taken.
fn cjk_font_at_weight(font_bytes: &[u8], weight: i32) -> Result<Vec<u8>, String> {
    let font_data = ReadScope::new(font_bytes)
        .read::<FontData<'_>>()
        .map_err(|error| format!("the fallback font could not be read: {error}"))?;
    let provider = font_data
        .table_provider(0)
        .map_err(|error| format!("the fallback font has no usable tables: {error}"))?;

    instance(&provider, &[Fixed::from(weight)])
        .map(|(bytes, _)| bytes)
        .map_err(|error| format!("the fallback font could not select weight {weight}: {error}"))
}

pub(super) fn regular_cjk_font(font_bytes: &[u8]) -> Result<Vec<u8>, String> {
    cjk_font_at_weight(font_bytes, CJK_REGULAR_FONT_WEIGHT)
}

/// Cuts one face of `font_bytes` down to just the glyphs `text` uses.
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
pub(super) fn subset_for(font_bytes: &[u8], index: usize, text: &str) -> Result<Vec<u8>, String> {
    subset_face(font_bytes, index, text, false)
}

/// Cuts one face of `font_bytes` — a plain font or a collection member — down to
/// just the glyphs `text` uses.
///
/// `require_coverage` refuses a face that would draw any of them as `.notdef`.
/// The page-number chain asks for it, having a next candidate to try; a note's
/// own text has none, and takes what the chosen face happens to hold.
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
            std::fs::read(bundled_font_path(CJK_FONT_NAME)).expect("read the fallback CJK font");

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

        let subset = subset_for(&instance, 0, "水印").expect("subset static font instance");
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
    fn the_system_face_is_embeddable_and_draws_the_probe() {
        // A machine with no embeddable CJK sans is a real answer, not a failed
        // test — it is exactly the case the downloadable fallback exists for.
        // What is asserted here is what the chain hands back when it finds one.
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

    #[test]
    fn the_fetched_pin_matches_the_download_script() {
        // The same bytes are named twice — fetched here at runtime, fetched by
        // `scripts/download-fonts.mjs` for the tests — and nothing else would
        // notice one being bumped while the other stayed put.
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
            FALLBACK_FONT_LICENSE_SOURCE,
            FALLBACK_FONT_LICENSE_NAME,
            CJK_FONT_NAME,
            &FALLBACK_FONT_BYTES.to_string(),
        ] {
            assert!(script.contains(pin), "the script no longer pins {pin}");
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
