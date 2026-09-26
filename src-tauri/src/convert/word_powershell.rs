//! Word/WPS automation over PowerShell (raw COM here is an untyped union);
//! paths reach the fixed script as arguments, never spliced into its code.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{
    run_with_timeout, unanswered_note, BatchOutcome, ConvertJob, ConvertSession, EngineKind,
    CONVERT_TIMEOUT, START_TIMEOUT,
};

pub(crate) const WORD_PROG_ID: &str = "Word.Application";
pub(crate) const WPS_PROG_ID: &str = "KWPS.Application";

/// One line per file on stdout — `OK|<input>` or `FAIL|<input>|<message>`;
/// files a killed run never answered become refusals for the next engine.
const CONVERT_SCRIPT: &str = r#"
param([string]$ProgId, [string]$Pairs)
$ErrorActionPreference = 'Stop'
# Redirected output is otherwise the OEM code page on Windows PowerShell 5.1,
# and a path with a non-ASCII character in it — the cache dir lives under the
# user's profile — would echo back as something else entirely. Some hosts
# refuse the switch on a redirected pipe; the per-file protocol must outlive
# that refusal, so a garbled path beats a script that never answers.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$application = $null
try {
    $application = New-Object -ComObject $ProgId
    $application.Visible = $false
    $application.DisplayAlerts = 0
    try { $application.AutomationSecurity = 3 } catch {}
    # One argument, '>'-joined: `-File` cannot bind several values to one
    # parameter, and neither separator may occur inside a Windows filename.
    foreach ($pair in $Pairs.Split('>')) {
        $parts = $pair -split '\|', 2
        $inputPath = $parts[0]
        $outputPath = $parts[1]
        try {
            $document = $application.Documents.Open($inputPath, $null, $true, $false)
            try {
                $document.ExportAsFixedFormat($outputPath, 17, $false)
                Write-Output "OK|$inputPath"
            } finally {
                $document.Close(0)
            }
        } catch {
            Write-Output "FAIL|$inputPath|$($_.Exception.Message)"
        }
    }
} finally {
    if ($null -ne $application) {
        try { $application.Quit() } catch {}
    }
}
"#;

/// HKCR is the merged view of per-user (Click-to-Run) and per-machine (MSI)
/// registration; looking activates nothing.
pub(crate) fn prog_id_installed(prog_id: &str) -> bool {
    windows_registry::CLASSES_ROOT.open(prog_id).is_ok()
}

pub(crate) struct Session {
    prog_id: &'static str,
    script: PathBuf,
}

pub(crate) fn open_session(kind: EngineKind, run_dir: &Path) -> Result<Session, String> {
    let prog_id = match kind {
        EngineKind::Word => WORD_PROG_ID,
        EngineKind::Wps => WPS_PROG_ID,
        EngineKind::LibreOffice => return Err("LibreOffice is not a script engine".into()),
    };

    // In this run's own directory, beside the staged copies: no second
    // instance of the app ever writes here.
    let script = run_dir.join("word-convert.ps1");

    fs::write(&script, CONVERT_SCRIPT)
        .map_err(|error| format!("the conversion script could not be staged: {error}"))?;

    Ok(Session { prog_id, script })
}

impl ConvertSession for Session {
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome {
        // One script run is the whole batch: an already-landed stop spends
        // nothing starting one; one during it waits for the script to end.
        // Killing PowerShell would skip the `finally` that quits the suite,
        // leaving a hidden Word holding the staged copy open.
        if cancelled() {
            return BatchOutcome::Done(
                jobs.iter()
                    .map(|_| Err("stopped by the reader".into()))
                    .collect(),
            );
        }

        // Each pair joins in|out with separators no Windows filename may
        // contain, and the pairs join into the one argument `-File` can bind.
        let pairs = jobs
            .iter()
            .map(|job| format!("{}|{}", job.staged.display(), job.output.display()))
            .collect::<Vec<_>>()
            .join(">");

        let mut command = Command::new("powershell.exe");

        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&self.script)
            .args(["-ProgId", self.prog_id])
            .arg("-Pairs")
            .arg(pairs);

        // The suite's startup is the slow part and happens once, so it is
        // owed in full however many files follow it.
        let timeout = START_TIMEOUT + CONVERT_TIMEOUT.saturating_mul(jobs.len() as u32);

        let finished = match run_with_timeout(&mut command, timeout, &|| false) {
            Ok(finished) => finished,
            Err(error) => return BatchOutcome::Engine(format!("PowerShell did not run: {error}")),
        };

        // A killed run's answers die with its pipes, so every file answers
        // unfinished below — refusals for the next engine, in order.
        let stdout = String::from_utf8_lossy(&finished.output.stdout);

        // A script that dies before its first file answers nothing on stdout;
        // its reason is PowerShell's own stderr (COM activation, a refused
        // encoding switch), and without it every file says only "stopped".
        let unanswered = format!(
            "did not finish before the engine was stopped{}",
            unanswered_note(&finished.output, finished.timed_out)
        );

        BatchOutcome::Done(
            jobs.iter()
                .zip(stdout.lines())
                .map(|(job, line)| answer_for(line, job))
                .chain(
                    jobs.iter()
                        .skip(stdout.lines().count())
                        .map(|_| Err(unanswered.clone())),
                )
                .collect(),
        )
    }

    fn finish(&mut self) {
        // The script quits the suite in its `finally`; a run killed past it
        // may leave one behind — the cost of never killing by name.
    }
}

/// A line in neither shape is a script that never got going — this file's
/// answer is no answer.
fn answer_for(line: &str, job: &ConvertJob) -> Result<(), String> {
    let mut parts = line.splitn(3, '|');

    match (parts.next(), parts.next(), parts.next()) {
        (Some("OK"), Some(path), None) if path == job.staged.to_string_lossy().as_ref() => Ok(()),
        (Some("FAIL"), Some(_), detail) => Err(detail.unwrap_or("the conversion failed").into()),
        _ => Err(format!(
            "the script answered in a shape it should not have: {line}"
        )),
    }
}
