//! Word on macOS over AppleScript, one script run per file: paths arrive as
//! arguments, never interpolated — a quote in a path is not a hole in what runs.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{run_with_timeout, BatchOutcome, ConvertJob, ConvertSession, CONVERT_TIMEOUT};

const WORD_BUNDLE_ID: &str = "com.microsoft.Word";

/// The first automation raises macOS's own permission prompt, which waits
/// for a person; the timeout must outlast a reader reading it.
const WORD_START_TIMEOUT: Duration = Duration::from_secs(120);

/// The document `open` hands back is the one saved and closed — never the
/// active one, which between Apple events can be the reader's own document.
const CONVERT_SCRIPT: &str = r#"
on run argv
    set inputPath to item 1 of argv
    set outputPath to item 2 of argv
    tell application id "com.microsoft.Word"
        set theDocument to open inputPath
        save as theDocument file name outputPath file format format PDF
        close theDocument saving no
    end tell
end run
"#;

/// Passive: launching Word to ask would put an icon in the reader's Dock.
pub(crate) fn word_installed() -> bool {
    let mut candidates = vec![PathBuf::from("/Applications/Microsoft Word.app")];

    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join("Applications")
                .join("Microsoft Word.app"),
        );
    }

    candidates.into_iter().any(|candidate| candidate.is_dir())
}

pub(crate) struct Session {
    script: PathBuf,
    /// Whether Word was already running when this session began. A session
    /// that started it quits it; one that found it running leaves it be.
    was_running: bool,
}

pub(crate) fn open_session(run_dir: &Path) -> Result<Session, String> {
    let script = run_dir.join("word-convert.applescript");

    fs::write(&script, CONVERT_SCRIPT)
        .map_err(|error| format!("the AppleScript could not be staged: {error}"))?;

    let was_running = word_is_running().ok_or_else(|| {
        "AppleScript could not be reached, so Word could not be asked about".to_string()
    })?;

    Ok(Session {
        script,
        was_running,
    })
}

/// Answerable without sending Word an event or launching it, so it never
/// triggers the automation permission prompt.
fn word_is_running() -> Option<bool> {
    let answer = Command::new("osascript")
        .args([
            "-e",
            &format!("application id \"{WORD_BUNDLE_ID}\" is running"),
        ])
        .output()
        .ok()?;

    Some(String::from_utf8_lossy(&answer.stdout).trim() == "true")
}

impl ConvertSession for Session {
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome {
        let mut results = Vec::with_capacity(jobs.len());

        for job in jobs {
            if cancelled() {
                results.push(Err("stopped by the reader".into()));
                continue;
            }

            let result = (|| -> Result<Result<(), String>, String> {
                let finished = run_with_timeout(
                    Command::new("osascript")
                        .arg(&self.script)
                        .arg(&job.staged)
                        .arg(&job.output),
                    WORD_START_TIMEOUT,
                )
                .map_err(|error| format!("AppleScript did not run: {error}"))?;

                if finished.timed_out {
                    // The first automation's permission prompt can outlast
                    // a file's share, not the batch's: this file, not the engine.
                    return Ok(Err("Word did not finish in time".into()));
                }

                if finished.output.status.success() {
                    return Ok(Ok(()));
                }

                let stderr = String::from_utf8_lossy(&finished.output.stderr);

                // -1743 is the reader's refusal of the automation prompt:
                // every file after would be too, so the engine retires here.
                if stderr.contains("-1743") || stderr.contains("not authorized") {
                    return Err("automation was not permitted".into());
                }

                Ok(Err(format!("Word refused the file: {}", stderr.trim())))
            })();

            match result {
                Ok(file_result) => results.push(file_result),
                Err(engine_failure) => {
                    // An engine-level end answers for every file still
                    // unconverted, including the ones already refused above.
                    while results.len() < jobs.len() {
                        results.push(Err(engine_failure.clone()));
                    }

                    break;
                }
            }
        }

        BatchOutcome::Done(results)
    }

    fn finish(&mut self) {
        if self.was_running {
            return;
        }

        // A Word this session started leaves with it, or it ghosts in the
        // Dock; a failed quit costs nothing that already succeeded.
        let _ = run_with_timeout(
            Command::new("osascript").args([
                "-e",
                &format!("tell application id \"{WORD_BUNDLE_ID}\" to quit"),
            ]),
            CONVERT_TIMEOUT,
        );
    }
}
