//! LibreOffice, the chain's last engine and the only one on Linux.
//!
//! Headless, one process per file, with a profile of this run's own: the
//! default profile belongs to whatever LibreOffice the reader may already
//! have open, and two soffice processes on one profile block each other.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{run_with_timeout, BatchOutcome, ConvertJob, ConvertSession, CONVERT_TIMEOUT};

/// Cold start plus profile creation plus the document itself. LibreOffice
/// starts slower than Word attaches, so it gets twice a single file's share.
const LIBREOFFICE_TIMEOUT: Duration = Duration::from_secs(CONVERT_TIMEOUT.as_secs() * 2);

pub(crate) struct Session {
    soffice: PathBuf,
}

impl Session {
    pub(crate) fn new(soffice: PathBuf) -> Self {
        Self { soffice }
    }
}

impl ConvertSession for Session {
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome {
        let mut results = Vec::with_capacity(jobs.len());

        for job in jobs {
            if cancelled() {
                results.push(Err("stopped by the reader".into()));
                continue;
            }

            results.push(convert_one(&self.soffice, job));
        }

        BatchOutcome::Done(results)
    }

    fn finish(&mut self) {
        // Nothing to close: each file was a process of its own, and the
        // profile lives and dies with the run directory.
    }
}

fn convert_one(soffice: &Path, job: &ConvertJob) -> Result<(), String> {
    // LibreOffice writes the input's stem plus .pdf beside it, under the
    // staged name only this source hashes to — no two can collide.
    let run_dir = job
        .staged
        .parent()
        .ok_or("the staged copy has no directory")?;
    let written = run_dir.join(format!(
        "{}.pdf",
        job.staged
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("converted")
    ));

    let mut command = Command::new(soffice);
    command.args(libreoffice_args(
        &run_dir.join("lo-profile"),
        run_dir,
        &job.staged,
    ));

    let finished = match run_with_timeout(&mut command, LIBREOFFICE_TIMEOUT) {
        Ok(finished) => finished,
        Err(error) => {
            return Err(format!("LibreOffice could not be started: {error}"));
        }
    };

    if finished.timed_out {
        return Err("LibreOffice did not finish in time".into());
    }

    if !finished.output.status.success() || fs::metadata(&written).is_err() {
        return Err(format!(
            "LibreOffice refused the file: {}",
            detail(&finished.output)
        ));
    }

    // Both ends are in the run directory: one rename, and the output
    // wears the name the rest of the run already knows it by.
    fs::rename(&written, &job.output)
        .map_err(|error| format!("the PDF could not be moved: {error}"))
}

/// The whole invocation, as arguments — no shell anywhere in the chain.
pub(crate) fn libreoffice_args(profile: &Path, out_dir: &Path, input: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--headless".into(),
        "--norestore".into(),
        "--convert-to".into(),
        "pdf".into(),
        "--outdir".into(),
        out_dir.to_path_buf().into_os_string(),
    ];

    // A profile of this run's own, so a running LibreOffice cannot block it.
    // The flag and its URL are one argument, not two.
    args.push(format!("-env:UserInstallation={}", file_url(profile)).into());
    args.push(input.to_path_buf().into_os_string());

    args
}

/// A `file:` URL for LibreOffice's `-env:` argument, which takes a URL
/// rather than a path. Only the URL grammar's unreserved characters and the
/// separators go through as themselves; everything else is percent-encoded,
/// so a path with spaces or either platform's non-ASCII names survives.
pub(crate) fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut url = String::from("file://");

    // A drive-prefixed Windows path is absolute without starting in '/', and
    // the URL grammar wants three slashes before it.
    if !text.starts_with('/') {
        url.push('/');
    }

    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                url.push(byte as char);
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }

    url
}

fn detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();

    // A refusal worth reading is short; a wall of launcher output is not.
    if stderr.chars().count() > 200 {
        stderr.chars().take(200).collect()
    } else {
        stderr.to_string()
    }
}

/// Where LibreOffice installs, by platform. Passive: files are looked for,
/// nothing is run. The PATH scan is last because distributions disagree
/// about where the real binary lives and PATH may hold a wrapper. Unused in
/// the e2e build, whose detection answers nothing at all.
#[cfg_attr(feature = "e2e", allow(dead_code))]
pub(crate) fn find_soffice() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(variable) {
            candidates.push(
                PathBuf::from(root)
                    .join("LibreOffice")
                    .join("program")
                    .join("soffice.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ));

        if let Some(home) = env::var_os("HOME") {
            candidates.push(
                PathBuf::from(home)
                    .join("Applications")
                    .join("LibreOffice.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("soffice"),
            );
        }
    }

    #[cfg(target_os = "linux")]
    for fixed in [
        "/usr/lib/libreoffice/program/soffice",
        "/usr/lib64/libreoffice/program/soffice",
        "/opt/libreoffice/program/soffice",
    ] {
        candidates.push(PathBuf::from(fixed));
    }

    candidates.extend(path_lookup(if cfg!(windows) {
        "soffice.exe"
    } else {
        "soffice"
    }));

    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

/// Every directory on the PATH, joined with `name`, in PATH order — the
/// platform's own separator rules, which `split_paths` knows.
fn path_lookup(name: &str) -> Vec<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();

    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .collect()
}

/// A file this process could run. The executable bit matters only where
/// there is one; Windows answers for the extension.
fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };

    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}
