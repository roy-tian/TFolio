//! One process per file, headless, with a profile of this run's own: two
//! soffice processes sharing the default profile would block each other.

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

    // The flag and its URL are one argument, not two.
    args.push(format!("-env:UserInstallation={}", file_url(profile)).into());
    args.push(input.to_path_buf().into_os_string());

    args
}

/// A `file:` URL for `-env:`, which takes a URL, not a path: everything
/// outside the grammar's unreserved set is percent-encoded.
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

/// Passive: files are looked for, nothing is run. The PATH scan is last
/// because PATH may hold a wrapper rather than the real binary.
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

fn path_lookup(name: &str) -> Vec<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();

    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .collect()
}

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
