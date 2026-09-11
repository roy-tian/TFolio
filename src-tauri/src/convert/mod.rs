//! Word documents brought into the merge wizard, converted to PDF by the
//! office software this machine already has.
//!
//! No converter ships with the app and none is pure Rust: the engines here
//! drive Microsoft Word and WPS through the automation interfaces they
//! already expose (PowerShell on Windows, AppleScript on macOS) and
//! LibreOffice through its command line, because those three are the only
//! renderers a Word file's layout can be trusted to. Fidelity orders the
//! chain — Word, then WPS, then LibreOffice — and a machine with none of
//! them answers with an error that names what to install rather than a
//! silent refusal.
//!
//! Everything here runs *outside* the PDFium lock: an office suite takes
//! seconds to start, and the merge pipeline calls in before it takes that
//! lock, exactly where image decoding already sits.

pub(crate) mod libreoffice;

#[cfg(target_os = "macos")]
pub(crate) mod word_applescript;
#[cfg(windows)]
pub(crate) mod word_powershell;

use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::pdfium::MAX_PDF_BYTES;

/// The one Word format pair the wizard accepts. The engines all read both;
/// anything older or richer (WordPerfect, .rtf, .odt) stays out until one of
/// them earns its place here.
pub(crate) const WORD_EXTENSIONS: [&str; 2] = ["doc", "docx"];

/// How long one file may take under one engine. Generous — a big document on
/// a cold Word start takes tens of seconds — but finite, because a hung
/// converter must give way to the next engine rather than park the wizard.
pub(crate) const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);

/// What starting an office suite may take before the first file is even
/// looked at. Bounded for the same reason as the per-file share.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(45);

/// Directories under the cache root from runs that never cleaned up after
/// themselves are swept once they are a day old. Newer ones are left alone:
/// on macOS a second instance may legitimately be mid-run.
const STALE_RUN_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const RUN_DIR_PREFIX: &str = "word-import-";

/// One convertible engine, in the order a file is offered to them. The
/// quieter platforms and the e2e build construct fewer of these than exist:
/// an engine is named where its software can actually be found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "e2e", allow(dead_code))]
pub(crate) enum EngineKind {
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Word,
    #[cfg_attr(not(windows), allow(dead_code))]
    Wps,
    #[cfg_attr(feature = "e2e", allow(dead_code))]
    LibreOffice,
}

impl EngineKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            EngineKind::Word => "Microsoft Word",
            EngineKind::Wps => "WPS Office",
            EngineKind::LibreOffice => "LibreOffice",
        }
    }
}

/// What resolving a batch did with one input path.
#[derive(Clone, Debug)]
pub(crate) enum Entry {
    /// Not a Word document — the caller reads it as whatever else it is.
    NotWord,
    /// Converted (or already cached); the path to read instead.
    Converted(PathBuf),
    /// This file needed converting, and no engine could.
    Failed(ConvertError),
}

#[derive(Clone, Debug)]
pub(crate) enum ConvertError {
    /// Nothing installed here converts Word documents at all.
    NoConverter,
    /// The engines that tried this file gave up on it; the string is theirs,
    /// for a log or an error dialog rather than the row's own wording.
    Failed(String),
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvertError::NoConverter => {
                write!(formatter, "no Word-compatible application is installed")
            }
            ConvertError::Failed(detail) => write!(formatter, "{detail}"),
        }
    }
}

/// A batch was asked to stop. The caller owns the stop flag and already
/// knows what its own "stopped" answer looks like.
#[derive(Debug)]
pub(crate) struct Cancelled;

/// One file's conversion, as an engine receives it: where the staged copy
/// sits, and where the PDF belongs. The names are the chain's, derived from
/// the source's identity, so no two jobs in a batch can collide.
#[derive(Clone, Debug)]
pub(crate) struct ConvertJob {
    pub(crate) staged: PathBuf,
    pub(crate) output: PathBuf,
}

/// One engine's whole answer to a batch of jobs.
pub(crate) enum BatchOutcome {
    /// One result per job, in order. `Ok` promises a converted file at the
    /// job's output path; `Err` is this engine's refusal of that one file —
    /// the engine itself stays in the chain's good books.
    Done(Vec<Result<(), String>>),
    /// The engine could not run at all. Every file in the batch moves on to
    /// the next engine untried, which is a different thing from refusing.
    /// Only the script engines report it, which is why quieter platforms
    /// never construct it.
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Engine(String),
}

/// How the chain asks for an engine's hold: detection in, session out. A
/// named shape because the chain hands it to its own tests as their seam.
pub(crate) type SessionOpener<'a> =
    dyn Fn(&Detected, EngineKind, &Path) -> Result<Box<dyn ConvertSession>, String> + 'a;

/// One engine's hold on the conversion machinery, for the length of one
/// batch. What "holding" means is the engine's: one Word for the whole batch
/// through a single script run, or a fresh process per file.
pub(crate) trait ConvertSession {
    /// Converts the batch, reading `cancelled` between its files: a stop
    /// must cost the rest of the batch, not a wait for it. Files a stop
    /// reaches come back as per-file errors — the chain, which knows what a
    /// stop means to its caller, is the one that turns them into one.
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome;
    /// Best-effort shutdown, called however the batch ended.
    fn finish(&mut self);
}

/// What one run of the app found installed, probed once: the engines worth
/// starting, in fidelity order, and where LibreOffice's binary is when it is.
pub(crate) struct Detected {
    pub(crate) engines: Vec<EngineKind>,
    pub(crate) soffice: Option<PathBuf>,
}

static DETECTED: OnceLock<Detected> = OnceLock::new();

fn detected() -> &'static Detected {
    DETECTED.get_or_init(probe)
}

/// Passive only: nothing here may start an office suite, because probing runs
/// at first use, in the middle of a gesture the reader is waiting on.
#[cfg(not(feature = "e2e"))]
fn probe() -> Detected {
    let mut engines = Vec::new();

    #[cfg(target_os = "macos")]
    if word_applescript::word_installed() {
        engines.push(EngineKind::Word);
    }

    #[cfg(windows)]
    {
        if word_powershell::prog_id_installed(word_powershell::WORD_PROG_ID) {
            engines.push(EngineKind::Word);
        }
        if word_powershell::prog_id_installed(word_powershell::WPS_PROG_ID) {
            engines.push(EngineKind::Wps);
        }
    }

    let soffice = libreoffice::find_soffice();

    if soffice.is_some() {
        engines.push(EngineKind::LibreOffice);
    }

    Detected { engines, soffice }
}

/// The e2e build answers deterministically: no engine, ever, so a spec never
/// depends on what the machine it runs on happens to have installed.
#[cfg(feature = "e2e")]
fn probe() -> Detected {
    Detected {
        engines: Vec::new(),
        soffice: None,
    }
}

/// Whether `path` is one of the Word formats the wizard converts. Matched on
/// the extension because this decides before anything reads the file — the
/// same bargain the image list makes.
pub(crate) fn is_word_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| WORD_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

/// The inputs' identity, taken once: what a cache entry is keyed on and what
/// a staged copy is named after, so an unchanged file is one hash all run.
#[derive(Clone)]
struct SourceFacts {
    canonical: PathBuf,
    mtime: SystemTime,
    size: u64,
    extension: String,
}

fn source_facts(path: &Path) -> Option<SourceFacts> {
    let metadata = fs::metadata(path).ok()?;

    if !metadata.is_file() {
        return None;
    }

    Some(SourceFacts {
        canonical: fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
        mtime: metadata.modified().ok()?,
        size: metadata.len(),
        extension: path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("docx")
            .to_ascii_lowercase(),
    })
}

/// A run's conversions: where they land, and which source file each one came
/// from. The cache is keyed by the source's identity — canonical path, mtime,
/// size — so a file edited between the wizard's list and its merge is
/// converted again rather than merged stale.
pub struct WordConverter {
    /// `None` when no cache directory could be had: conversion then has
    /// nowhere to stage a copy or write a result, and says so per file.
    run_dir: Option<PathBuf>,
    cache: Mutex<HashMap<PathBuf, CachedPdf>>,
    /// Held for a whole batch. Everything a batch touches is named by the
    /// run directory alone, so two batches at once — two windows importing
    /// Word files — would overwrite each other's staged copies and share one
    /// LibreOffice profile; waiting a batch out is the cheaper mistake.
    gate: Mutex<()>,
}

struct CachedPdf {
    mtime: SystemTime,
    size: u64,
    pdf: PathBuf,
}

impl WordConverter {
    pub fn new(app: &AppHandle) -> Self {
        let run_dir = app
            .path()
            .app_cache_dir()
            .ok()
            .map(|directory| directory.join(format!("{RUN_DIR_PREFIX}{}", std::process::id())));

        if let Some(directory) = &run_dir {
            // Made here rather than at first use: a missing directory in
            // the middle of a conversion would read as the file's refusal.
            let _ = fs::create_dir_all(directory);
            sweep_stale_runs(directory);
        }

        Self {
            run_dir,
            cache: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
        }
    }

    /// For tests: a converter pointed at a directory of the caller's making,
    /// with the startup sweep skipped — a test's scratch tree is brand new.
    #[cfg(test)]
    pub(crate) fn at_directory(run_dir: PathBuf) -> Self {
        Self {
            run_dir: Some(run_dir),
            cache: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
        }
    }

    /// For tests: a converter with nowhere to put anything, whose every Word
    /// document answers the same deterministic refusal — the engine's own
    /// wiring can then be tested without an office suite in sight.
    #[cfg(test)]
    pub(crate) fn nowhere() -> Self {
        Self {
            run_dir: None,
            cache: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
        }
    }

    /// How many of `paths` would be converted right now — what a progress
    /// total can promise before the work starts. Cache hits count as nothing.
    pub(crate) fn pending_count(&self, paths: &[PathBuf]) -> usize {
        paths
            .iter()
            .filter(|path| is_word_document(path) && self.cached(path).is_none())
            .count()
    }

    /// Reads each Word document among `paths` into a PDF of this run's own,
    /// returning one entry per input, in order. Non-Word paths come back
    /// untouched; the caller goes on reading those as it always did.
    pub(crate) fn resolve(
        &self,
        paths: &[PathBuf],
        cancelled: &dyn Fn() -> bool,
        on_converted: &mut dyn FnMut(),
    ) -> Result<Vec<Entry>, Cancelled> {
        self.resolve_with(detected(), paths, cancelled, on_converted, &open_session)
    }

    fn resolve_with(
        &self,
        detected: &Detected,
        paths: &[PathBuf],
        cancelled: &dyn Fn() -> bool,
        on_converted: &mut dyn FnMut(),
        open_session: &SessionOpener<'_>,
    ) -> Result<Vec<Entry>, Cancelled> {
        // One batch at a time, process-wide — see `gate`. A poisoned lock is
        // opened rather than refused: refusing it would ban conversion.
        let _batch = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut entries: Vec<Entry> = vec![Entry::NotWord; paths.len()];
        let mut pending: Vec<(usize, SourceFacts, ConvertJob)> = Vec::new();
        // A path listed twice in one batch is one conversion: the second
        // entry points at the first's answer, not a rival under its name.
        let mut first_for: HashMap<PathBuf, usize> = HashMap::new();
        let mut duplicates: HashMap<usize, usize> = HashMap::new();

        for (index, path) in paths.iter().enumerate() {
            if cancelled() {
                return Err(Cancelled);
            }

            if !is_word_document(path) {
                continue;
            }

            let Some(run_dir) = &self.run_dir else {
                entries[index] = Entry::Failed(ConvertError::Failed(
                    "the app's cache directory is unavailable".into(),
                ));
                continue;
            };

            let Some(facts) = source_facts(path) else {
                entries[index] = Entry::Failed(ConvertError::Failed(format!(
                    "could not read {}",
                    path.display()
                )));
                continue;
            };

            if let Some(first) = first_for.get(&facts.canonical) {
                duplicates.insert(index, *first);
                continue;
            }

            first_for.insert(facts.canonical.clone(), index);

            if let Some(pdf) = cached_pdf(&self.cache, &facts) {
                entries[index] = Entry::Converted(pdf);
            } else {
                // Staging is the chain's, not an engine's: a staging failure
                // is final, because no engine fixes an unread copy.
                match stage(run_dir, &facts) {
                    Ok(job) => pending.push((index, facts, job)),
                    Err(error) => entries[index] = Entry::Failed(ConvertError::Failed(error)),
                }
            }
        }

        // Why each still-pending file has been refused so far, per engine:
        // the notes are what a final failure names, in the order gathered.
        let mut refusals: HashMap<usize, Vec<String>> = HashMap::new();
        let mut note = |index: usize, kind: EngineKind, detail: &str| {
            refusals
                .entry(index)
                .or_default()
                .push(format!("{}: {detail}", kind.label()));
        };

        for &kind in &detected.engines {
            if pending.is_empty() || cancelled() {
                break;
            }

            let run_dir = self.run_dir.as_deref().unwrap_or_else(|| Path::new(""));

            let mut session = match open_session(detected, kind, run_dir) {
                Ok(session) => session,
                // Starting the engine failed, not converting under it: every
                // pending file moves on to the next engine untried.
                Err(error) => {
                    let detail = format!("could not be started: {error}");

                    for (index, _, _) in &pending {
                        note(*index, kind, &detail);
                    }

                    continue;
                }
            };

            let jobs: Vec<ConvertJob> = pending.iter().map(|(_, _, job)| job.clone()).collect();

            let outcome = session.convert(&jobs, cancelled);
            session.finish();

            match outcome {
                BatchOutcome::Engine(error) => {
                    for (index, _, _) in &pending {
                        note(*index, kind, &error);
                    }
                }
                BatchOutcome::Done(results) => {
                    let mut leftover = Vec::new();

                    for ((index, facts, job), result) in pending.iter().zip(results) {
                        // An Ok worth believing is an output that really is
                        // a PDF; anything less refuses, and the file rides on.
                        let conversion = result.and_then(|()| validate_pdf(&job.output));

                        match conversion {
                            Ok(()) => {
                                entries[*index] = Entry::Converted(job.output.clone());
                                on_converted();

                                if let Ok(mut cache) = self.cache.lock() {
                                    cache.insert(
                                        facts.canonical.clone(),
                                        CachedPdf {
                                            mtime: facts.mtime,
                                            size: facts.size,
                                            pdf: job.output.clone(),
                                        },
                                    );
                                }
                            }
                            Err(detail) => {
                                let _ = fs::remove_file(&job.output);
                                note(*index, kind, &detail);
                                leftover.push((*index, facts.clone(), job.clone()));
                            }
                        }
                    }

                    pending = leftover;
                }
            }

            // After the results fold in, so a stop keeps what converted —
            // the cache holds it — and answers with the stop, not a half-list.
            if cancelled() {
                return Err(Cancelled);
            }
        }

        if !pending.is_empty() {
            if detected.engines.is_empty() {
                for (index, _, _) in pending {
                    entries[index] = Entry::Failed(ConvertError::NoConverter);
                }
            } else {
                for (index, _, _) in pending {
                    let notes = refusals.remove(&index).unwrap_or_default().join("; ");

                    entries[index] = Entry::Failed(ConvertError::Failed(notes));
                }
            }
        }

        for (duplicate, first) in duplicates {
            entries[duplicate] = entries[first].clone();
        }

        Ok(entries)
    }

    fn cached(&self, path: &Path) -> Option<PathBuf> {
        let facts = source_facts(path)?;

        cached_pdf(&self.cache, &facts)
    }
}

/// A cache hit the output file still backs: recorded for exactly these file
/// facts, with its PDF still on disk.
fn cached_pdf(cache: &Mutex<HashMap<PathBuf, CachedPdf>>, facts: &SourceFacts) -> Option<PathBuf> {
    let cache = cache.lock().ok()?;
    let cached = cache.get(&facts.canonical)?;

    if cached.mtime == facts.mtime
        && cached.size == facts.size
        && fs::metadata(&cached.pdf).is_ok_and(|metadata| metadata.is_file())
    {
        Some(cached.pdf.clone())
    } else {
        None
    }
}

/// Copies the source into the run directory, under the name its identity
/// hashes to, and hands back where the converted PDF belongs.
///
/// The copy is what keeps the office suite away from the reader's own file:
/// Word writes an owner file beside what it opens and refuses read-only
/// folders outright, and a converted-from copy carries no mark-of-the-web, so
/// Protected View — which blocks automation entirely — never engages.
fn stage(run_dir: &Path, facts: &SourceFacts) -> Result<ConvertJob, String> {
    let hash = source_hash(facts);
    let staged = run_dir.join(format!("staged-{hash}.{}", facts.extension));

    let copied = fs::copy(&facts.canonical, &staged)
        .map_err(|error| format!("could not stage the file: {error}"))?;

    if copied != facts.size {
        return Err("the file changed while it was being staged".into());
    }

    strip_download_marks(&staged);

    Ok(ConvertJob {
        staged,
        output: run_dir.join(format!("{hash}.pdf")),
    })
}

/// SHA-256 over the file's identity, truncated for the name only: a collision
/// between two staging names would have to coincide with identical paths,
/// mtimes and sizes to matter, and the cache is keyed in full regardless.
fn source_hash(facts: &SourceFacts) -> String {
    let mut hasher = Sha256::new();

    hasher.update(facts.canonical.to_string_lossy().as_bytes());
    hasher.update(
        facts
            .mtime
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|moment| moment.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    );
    hasher.update(facts.size.to_le_bytes());

    let digest = hasher.finalize();
    let mut name = String::with_capacity(16);

    for byte in &digest[..8] {
        name.push_str(&format!("{byte:02x}"));
    }

    name
}

/// The output an engine claims to have written, held to the same standard any
/// other file is before PDFium is pointed at it. A non-PDF result is a file
/// failure — it says the converter gave up, not that the engine is broken.
fn validate_pdf(output: &Path) -> Result<(), String> {
    let metadata = fs::metadata(output).map_err(|error| format!("no PDF was written: {error}"))?;

    if !metadata.is_file() {
        return Err("no PDF was written".into());
    }

    if metadata.len() > MAX_PDF_BYTES as u64 {
        return Err("the PDF exceeds the app's size limit".into());
    }

    let mut header = [0u8; 5];

    fs::File::open(output)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("the PDF could not be read back: {error}"))?;

    if &header != b"%PDF-" {
        return Err("what was written is not a PDF".into());
    }

    Ok(())
}

/// The mark the OS puts on a downloaded file, which an office suite reads as
/// a reason to refuse automation — Protected View on Windows, quarantine on
/// macOS. `fs::copy` carries the mark along, so it is dropped here: the
/// staged copy is ours, in our own run directory, and dropping it there says
/// nothing about the reader's original.
#[cfg(windows)]
fn strip_download_marks(staged: &Path) {
    // The colon-qualified name goes straight to `DeleteFileW`, which is what
    // an alternate stream is named by.
    let _ = fs::remove_file(format!("{}:Zone.Identifier", staged.to_string_lossy()));
}

#[cfg(target_os = "macos")]
fn strip_download_marks(staged: &Path) {
    // No std surface for extended attributes, and an error here is the
    // common case: the attribute not being there to drop.
    let _ = std::process::Command::new("xattr")
        .args(["-d", "com.apple.quarantine"])
        .arg(staged)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(any(windows, target_os = "macos")))]
fn strip_download_marks(_staged: &Path) {}

/// Deletes this run's older siblings: a crash leaves its staged copies and
/// converted PDFs behind, and nothing else ever comes back for them.
fn sweep_stale_runs(run_dir: &Path) {
    let Some(root) = run_dir.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    let own_name = run_dir.file_name().and_then(|name| name.to_str());

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };

        if !name.starts_with(RUN_DIR_PREFIX) || Some(name) == own_name {
            continue;
        }

        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_RUN_AGE);

        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Sessions arrive as their engine's own type and leave as the chain's one —
/// named so each arm says what it opens rather than how it is boxed. Only
/// the script engines' arms call it, which the quiet platforms never build.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn box_session(session: impl ConvertSession + 'static) -> Box<dyn ConvertSession> {
    Box::new(session)
}

/// Runs one engine's session opener with the run's own detection result.
fn open_session(
    detected: &Detected,
    kind: EngineKind,
    run_dir: &Path,
) -> Result<Box<dyn ConvertSession>, String> {
    match kind {
        EngineKind::Word | EngineKind::Wps => {
            #[cfg(windows)]
            {
                let _ = detected;
                word_powershell::open_session(kind, run_dir).map(box_session)
            }
            #[cfg(not(windows))]
            {
                let _ = detected;

                // Word on macOS is driven over AppleScript. WPS exposes no
                // automation there, and on Linux neither does Word.
                #[cfg(target_os = "macos")]
                if kind == EngineKind::Word {
                    return word_applescript::open_session(run_dir).map(box_session);
                }

                let _ = run_dir;

                Err(format!(
                    "{} is not automatable on this platform",
                    kind.label()
                ))
            }
        }
        EngineKind::LibreOffice => {
            let soffice = detected
                .soffice
                .clone()
                .ok_or_else(|| "LibreOffice was not found".to_string())?;

            Ok(Box::new(libreoffice::Session::new(soffice)))
        }
    }
}

/// A command that ran, and whether it was killed for taking too long. Even a
/// killed run keeps whatever it had written to its pipes by then — an engine
/// that finished three files before the fourth hung still reports the three.
pub(crate) struct Ran {
    pub(crate) output: Output,
    pub(crate) timed_out: bool,
}

/// Runs `command` to completion, or kills it at `timeout`.
///
/// Killing reaches the child this process spawned and no other process of
/// that name — a reader's own LibreOffice, or a Word they are working in,
/// must never be killed over an import. A grandchild the wrapper spawned
/// instead of exec'ing is left to notice its dead parent and leave on its
/// own; the isolated profile and staged copies keep it from mattering here.
pub(crate) fn run_with_timeout(command: &mut Command, timeout: Duration) -> std::io::Result<Ran> {
    // A converter is never the reader's console: this app has none to give,
    // and Windows would otherwise flash one for every script or soffice run.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error),
        }
    }

    if timed_out {
        // The pipes are abandoned, not drained: a grandchild holds their
        // ends, and the partial answers die with it — files, never liveness.
        let status = child.wait()?;

        return Ok(Ran {
            output: Output {
                status,
                stdout: Vec::new(),
                stderr: Vec::new(),
            },
            timed_out: true,
        });
    }

    let output = child.wait_with_output()?;

    Ok(Ran { output, timed_out })
}

#[cfg(test)]
mod tests;
