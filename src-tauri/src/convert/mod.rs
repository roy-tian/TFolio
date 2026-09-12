//! Word-to-PDF conversion through the machine's own office software, in
//! fidelity order — Word, WPS, LibreOffice; on Windows, Word and WPS alone.

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
    process::{Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::pdfium::MAX_PDF_BYTES;

/// Both engines read .doc and .docx; anything richer waits until one earns it.
pub(crate) const WORD_EXTENSIONS: [&str; 2] = ["doc", "docx"];

/// Generous (a cold Word start takes tens of seconds) but finite: a hung
/// converter must give way to the next engine.
pub(crate) const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(45);

/// Newer run directories are left alone: on macOS a second instance may
/// legitimately be mid-run.
const STALE_RUN_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const RUN_DIR_PREFIX: &str = "word-import-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "e2e", allow(dead_code))]
pub(crate) enum EngineKind {
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Word,
    #[cfg_attr(not(windows), allow(dead_code))]
    Wps,
    #[cfg_attr(any(windows, feature = "e2e"), allow(dead_code))]
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

#[derive(Clone, Debug)]
pub(crate) enum Entry {
    NotWord,
    Converted(PathBuf),
    Failed(ConvertError),
}

#[derive(Clone, Debug)]
pub(crate) enum ConvertError {
    NoConverter,
    /// The refusing engines' own text, verbatim — for logs, not row wording.
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

#[derive(Debug)]
pub(crate) struct Cancelled;

#[derive(Clone, Debug)]
pub(crate) struct ConvertJob {
    pub(crate) staged: PathBuf,
    pub(crate) output: PathBuf,
}

pub(crate) enum BatchOutcome {
    /// Per file in order: `Err` refuses that one file; the engine stays in the chain.
    Done(Vec<Result<(), String>>),
    /// The engine could not run: the whole batch moves on untried.
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Engine(String),
}

/// Named rather than inline: the chain's tests use it as their seam.
pub(crate) type SessionOpener<'a> =
    dyn Fn(&Detected, EngineKind, &Path) -> Result<Box<dyn ConvertSession>, String> + 'a;

/// One batch long; what holding means is the engine's — one script run, or a
/// process per file.
pub(crate) trait ConvertSession {
    /// Poll `cancelled` between files: a stop costs the rest of the batch as
    /// per-file errors, which the chain turns into its own stop answer.
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome;
    /// Best-effort shutdown, called however the batch ended.
    fn finish(&mut self);
}

pub(crate) struct Detected {
    pub(crate) engines: Vec<EngineKind>,
    pub(crate) soffice: Option<PathBuf>,
}

static DETECTED: OnceLock<Detected> = OnceLock::new();

fn detected() -> &'static Detected {
    DETECTED.get_or_init(probe)
}

/// Whether the wizard may promise Word conversion: the machine's own
/// suites, detected passively — never a reader setting.
pub(crate) fn word_available() -> bool {
    // E2e answers yes with no engine behind it, so specs can drive the row
    // a refused conversion leaves; a closed door would never show it.
    if cfg!(feature = "e2e") {
        return true;
    }

    !detected().engines.is_empty()
}

#[tauri::command]
pub fn word_conversion_available() -> bool {
    word_available()
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

    // Windows stops at Word and WPS: LibreOffice is too rare there to chase,
    // and soffice.exe answers before the PDF lands (only its .com twin waits).
    #[cfg(not(windows))]
    let soffice = libreoffice::find_soffice();
    #[cfg(windows)]
    let soffice: Option<PathBuf> = None;

    #[cfg(not(windows))]
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

/// Extension only: this decides before anything reads the file.
pub(crate) fn is_word_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| WORD_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

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

/// The cache is keyed by canonical path, mtime and size, so a file edited
/// between listing and merging converts again rather than merging stale.
pub struct WordConverter {
    run_dir: Option<PathBuf>,
    cache: Mutex<HashMap<PathBuf, CachedPdf>>,
    /// Held for a whole batch: two windows importing at once would overwrite
    /// each other's staged copies and share one LibreOffice profile.
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

    /// No startup sweep: a test's scratch tree is brand new.
    #[cfg(test)]
    pub(crate) fn at_directory(run_dir: PathBuf) -> Self {
        Self {
            run_dir: Some(run_dir),
            cache: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn nowhere() -> Self {
        Self {
            run_dir: None,
            cache: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
        }
    }

    pub(crate) fn pending_count(&self, paths: &[PathBuf]) -> usize {
        paths
            .iter()
            .filter(|path| is_word_document(path) && self.cached(path).is_none())
            .count()
    }

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
        // A poisoned gate is opened rather than refused: refusing it would
        // ban conversion process-wide.
        let _batch = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut entries: Vec<Entry> = vec![Entry::NotWord; paths.len()];
        let mut pending: Vec<(usize, SourceFacts, ConvertJob)> = Vec::new();
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

/// The copy keeps the suite away from the reader's own file (Word writes
/// owner files, refuses read-only folders) and carries no mark-of-the-web.
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

/// Truncated for the name only: a colliding name would still mean identical
/// facts, and the cache is keyed in full regardless.
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

/// An engine's claim is not trusted: a non-PDF output refuses the file, not the engine.
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

/// Office suites refuse to automate marked files, and `fs::copy` carries the
/// mark over — dropped on our staged copy, never the reader's original.
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

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn box_session(session: impl ConvertSession + 'static) -> Box<dyn ConvertSession> {
    Box::new(session)
}

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

pub(crate) struct Ran {
    pub(crate) output: Output,
    pub(crate) timed_out: bool,
}

/// Kills only the child this process spawned, never a process by name: a
/// reader's own Word or LibreOffice must never die over an import.
pub(crate) fn run_with_timeout(command: &mut Command, timeout: Duration) -> std::io::Result<Ran> {
    // A converter is never the reader's console: this app has none to give,
    // and Windows would otherwise flash one for every script or soffice run.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    // Piped, else `wait_with_output` reads nothing back — a few short lines
    // per file cannot fill the pipe's 64KB buffer while the deadline polls.
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

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
