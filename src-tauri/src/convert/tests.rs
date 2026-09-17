//! The chain's own logic, tested against sessions that are whatever the test
//! needs them to be: no engine, no office suite, no platform.

use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use super::{
    libreoffice, BatchOutcome, ConvertError, ConvertJob, ConvertSession, Detected, EngineKind,
    Entry, WordConverter,
};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("tfolio-convert-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("a scratch directory should be creatable");

        Scratch(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// A file whose contents name it, so two of them can never be confused.
    fn document(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.0.join(name);

        fs::write(&path, contents).expect("a scratch document should be writable");

        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct Log {
    opened: Vec<&'static str>,
    conversions: usize,
    finished: usize,
}

#[derive(Clone)]
struct EnginePlan {
    name: &'static str,
    /// Input contents this engine refuses, as per-file failures.
    refuses: Vec<&'static str>,
    /// The rest come back unfinished — a killed run's shape, not a broken engine's.
    answers_before_stopping: Option<usize>,
    never_runs: bool,
}

struct FakeSession {
    plan: EnginePlan,
    log: Arc<Mutex<Log>>,
    seen: usize,
    /// Flips `stop_flag` once this many files have converted, modelling a
    /// reader whose stop lands in the middle of an engine's batch.
    stop_after: Option<usize>,
    stop_flag: Option<Arc<Cell<bool>>>,
}

impl ConvertSession for FakeSession {
    fn convert(&mut self, jobs: &[ConvertJob], cancelled: &dyn Fn() -> bool) -> BatchOutcome {
        let mut results = Vec::with_capacity(jobs.len());

        for job in jobs {
            if cancelled() {
                results.push(Err("stopped by the reader".into()));
                continue;
            }

            self.seen += 1;

            if let Some(answered) = self.plan.answers_before_stopping {
                if self.seen > answered {
                    results.push(Err("did not finish before the engine was stopped".into()));
                    continue;
                }
            }

            let contents = fs::read_to_string(&job.staged).unwrap_or_default();

            if self
                .plan
                .refuses
                .iter()
                .any(|refused| contents.contains(refused))
            {
                results.push(Err("the file was refused".into()));
                continue;
            }

            fs::write(&job.output, "%PDF-1.7 (fake)").expect("a fake PDF should be writable");
            self.log.lock().unwrap().conversions += 1;

            if self.stop_after == Some(self.seen) {
                if let Some(stop) = &self.stop_flag {
                    stop.set(true);
                }
            }

            results.push(Ok(()));
        }

        BatchOutcome::Done(results)
    }

    fn finish(&mut self) {
        self.log.lock().unwrap().finished += 1;
    }
}

fn run(
    converter: &WordConverter,
    engines: &[EngineKind],
    paths: &[PathBuf],
    plans: &[EnginePlan],
) -> (Result<Vec<Entry>, super::Cancelled>, Arc<Mutex<Log>>) {
    let log = Arc::new(Mutex::new(Log::default()));
    let detected = Detected {
        engines: engines.to_vec(),
        soffice: None,
    };

    // Cells rather than mutation, so the opener stays an `Fn` the way the
    // real session opener is; one plan per engine, in engine order.
    let next = Cell::new(0usize);
    let shared_log = Arc::clone(&log);
    let opener = move |_detected: &Detected, kind: EngineKind, _run_dir: &Path| {
        let index = next.get();

        next.set(index + 1);

        let plan = plans
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("an engine past the plan was opened: {}", kind.label()));

        shared_log.lock().unwrap().opened.push(plan.name);

        if plan.never_runs {
            return Err::<Box<dyn ConvertSession>, String>(plan.name.to_string());
        }

        Ok(Box::new(FakeSession {
            plan,
            log: Arc::clone(&shared_log),
            seen: 0,
            stop_after: None,
            stop_flag: None,
        }) as Box<dyn ConvertSession>)
    };

    let entries = converter.resolve_with(&detected, paths, &|| false, &mut || {}, &opener);

    (entries, log)
}

fn converted(entries: &[Entry]) -> Vec<Option<PathBuf>> {
    entries
        .iter()
        .map(|entry| match entry {
            Entry::Converted(pdf) => Some(pdf.clone()),
            _ => None,
        })
        .collect()
}

fn word_engine() -> EnginePlan {
    EnginePlan {
        name: "word",
        refuses: vec![],
        answers_before_stopping: None,
        never_runs: false,
    }
}

#[test]
fn word_documents_are_matched_by_extension_alone() {
    let scratch = Scratch::new("extensions");

    assert!(super::is_word_document(&scratch.document("a.docx", "x")));
    assert!(super::is_word_document(&scratch.document("b.DOC", "x")));
    assert!(!super::is_word_document(
        &scratch.document("c.docx.txt", "x")
    ));
    assert!(!super::is_word_document(&scratch.document("d.pdf", "x")));
    assert!(!super::is_word_document(
        &scratch.document("no-extension", "x")
    ));
}

#[test]
fn file_urls_percent_encode_everything_but_the_grammar() {
    assert_eq!(
        libreoffice::file_url(Path::new("/tmp/a b/文档.pdf")),
        "file:///tmp/a%20b/%E6%96%87%E6%A1%A3.pdf"
    );
}

#[test]
fn libreoffice_is_invoked_headless_with_its_own_profile() {
    let args = libreoffice::libreoffice_args(
        Path::new("/run/lo-profile"),
        Path::new("/run"),
        Path::new("/run/staged-abc.docx"),
    );

    let words: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    assert_eq!(
        words,
        vec![
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            "/run",
            "-env:UserInstallation=file:///run/lo-profile",
            "/run/staged-abc.docx",
        ]
    );
}

#[test]
fn a_machine_with_no_engine_names_what_is_missing() {
    let scratch = Scratch::new("no-engine");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let (entries, _) = run(
        &converter,
        &[],
        &[scratch.document("letter.docx", "hello")],
        &[],
    );

    assert!(matches!(
        entries.expect("an empty chain is a chain, not a stop")[0],
        Entry::Failed(ConvertError::NoConverter)
    ));
}

#[test]
fn a_converted_file_is_cached_until_it_changes() {
    let scratch = Scratch::new("cache");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let document = scratch.document("letter.docx", "first draft");

    let (first, first_log) = run(
        &converter,
        &[EngineKind::Word],
        &[document.clone()],
        &[word_engine()],
    );
    let (second, second_log) = run(
        &converter,
        &[EngineKind::Word],
        &[document.clone()],
        &[word_engine()],
    );

    let first_entry = converted(&first.expect("the first run converts"));

    assert_eq!(
        first_entry,
        converted(&second.expect("the cached run is served"))
    );
    assert_eq!(first_log.lock().unwrap().conversions, 1);
    assert_eq!(second_log.lock().unwrap().opened.len(), 0);

    fs::write(&document, "first draft, now considerably longer").unwrap();

    let (third, _) = run(
        &converter,
        &[EngineKind::Word],
        &[document],
        &[word_engine()],
    );

    assert_ne!(
        first_entry,
        converted(&third.expect("the edited file converts again"))
    );
}

#[test]
fn non_word_files_pass_through_untouched() {
    let scratch = Scratch::new("passthrough");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let (entries, log) = run(
        &converter,
        &[EngineKind::LibreOffice],
        &[scratch.document("scan.png", "not really")],
        &[],
    );

    assert!(matches!(
        entries.expect("nothing to convert")[0],
        Entry::NotWord
    ));
    assert_eq!(log.lock().unwrap().opened.len(), 0);
}

#[test]
fn a_refused_file_falls_through_to_the_next_engine() {
    let scratch = Scratch::new("fallthrough");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());

    let (entries, log) = run(
        &converter,
        &[EngineKind::Word, EngineKind::LibreOffice],
        &[scratch.document("difficult.docx", "locked for editing")],
        &[
            EnginePlan {
                name: "word",
                refuses: vec!["locked"],
                answers_before_stopping: None,
                never_runs: false,
            },
            EnginePlan {
                name: "libreoffice",
                refuses: vec![],
                answers_before_stopping: None,
                never_runs: false,
            },
        ],
    );

    assert!(converted(&entries.expect("the second engine takes it"))[0].is_some());

    let log = log.lock().unwrap();

    assert_eq!(log.opened, vec!["word", "libreoffice"]);
    assert_eq!(log.finished, 2, "both engines are shut down, not abandoned");
}

#[test]
fn an_engine_that_never_runs_hands_the_whole_batch_on() {
    let scratch = Scratch::new("never-runs");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());

    let (entries, log) = run(
        &converter,
        &[EngineKind::Word, EngineKind::LibreOffice],
        &[
            scratch.document("first.docx", "fine"),
            scratch.document("second.docx", "also fine"),
        ],
        &[
            EnginePlan {
                name: "word",
                refuses: vec![],
                answers_before_stopping: None,
                never_runs: true,
            },
            EnginePlan {
                name: "libreoffice",
                refuses: vec![],
                answers_before_stopping: None,
                never_runs: false,
            },
        ],
    );

    let results = converted(&entries.expect("the second engine takes the batch"));

    assert!(results[0].is_some());
    assert!(results[1].is_some());

    let log = log.lock().unwrap();

    assert_eq!(log.opened, vec!["word", "libreoffice"]);
    assert_eq!(log.conversions, 2);
}

#[test]
fn files_a_killed_run_left_unfinished_reach_the_next_engine() {
    let scratch = Scratch::new("unfinished");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());

    let (entries, _) = run(
        &converter,
        &[EngineKind::Word, EngineKind::LibreOffice],
        &[
            scratch.document("first.docx", "fine"),
            scratch.document("second.docx", "also fine"),
        ],
        &[
            EnginePlan {
                name: "word",
                refuses: vec![],
                answers_before_stopping: Some(1),
                never_runs: false,
            },
            word_engine(),
        ],
    );

    let results = converted(&entries.expect("the rest of the batch carries on"));

    assert!(results[0].is_some());
    assert!(results[1].is_some());
}

#[test]
fn every_file_refused_everywhere_is_a_failure_per_file() {
    let scratch = Scratch::new("all-refused");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());

    let refusing = EnginePlan {
        name: "engine",
        refuses: vec!["password"],
        answers_before_stopping: None,
        never_runs: false,
    };

    let (entries, _) = run(
        &converter,
        &[EngineKind::Word, EngineKind::LibreOffice],
        &[scratch.document("sealed.docx", "password protected")],
        &[refusing.clone(), refusing],
    );

    match &entries.expect("refusal is an answer")[0] {
        Entry::Failed(ConvertError::Failed(detail)) => {
            assert!(
                detail.contains("Microsoft Word"),
                "names the engines: {detail}"
            );
            assert!(
                detail.contains("LibreOffice"),
                "names every engine: {detail}"
            );
        }
        other => panic!("the file should have failed, not {other:?}"),
    }
}

#[test]
fn a_stop_between_files_stops_the_batch() {
    let scratch = Scratch::new("stopped");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let detected = Detected {
        engines: vec![EngineKind::Word],
        soffice: None,
    };

    // The second ask is the reader's stop landing between the two files.
    let asks = Cell::new(0);

    let stopped = converter.resolve_with(
        &detected,
        &[
            scratch.document("first.docx", "fine"),
            scratch.document("second.docx", "also fine"),
        ],
        &|| {
            asks.set(asks.get() + 1);
            asks.get() > 1
        },
        &mut || {},
        &|_, _, _| panic!("a stopped batch opens no engine"),
    );

    assert!(stopped.is_err(), "the stop must reach the chain");
}

#[test]
fn a_stop_mid_batch_keeps_what_it_already_converted() {
    let scratch = Scratch::new("mid-batch-stop");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let detected = Detected {
        engines: vec![EngineKind::Word],
        soffice: None,
    };

    // The stop lands inside the session, after the first file. Written
    // once and named twice: a rewrite's mtime is nothing to test against.
    let first = scratch.document("first.docx", "fine");
    let second = scratch.document("second.docx", "also fine");
    let stop = Arc::new(Cell::new(false));

    let stopped = converter.resolve_with(
        &detected,
        &[first.clone(), second.clone()],
        &|| stop.get(),
        &mut || {},
        &|_, _, _| {
            Ok(Box::new(FakeSession {
                plan: word_engine(),
                log: Arc::new(Mutex::new(Log::default())),
                seen: 0,
                stop_after: Some(1),
                stop_flag: Some(Arc::clone(&stop)),
            }) as Box<dyn ConvertSession>)
        },
    );

    assert!(stopped.is_err(), "a stopped batch answers with the stop");

    let (retry, retry_log) = run(
        &converter,
        &[EngineKind::Word],
        &[first, second],
        &[word_engine()],
    );

    let retry_entries = converted(&retry.expect("the retry runs"));

    assert!(retry_entries[0].is_some());
    assert!(retry_entries[1].is_some());
    assert_eq!(
        retry_log.lock().unwrap().conversions,
        1,
        "only the never-converted file converts again"
    );
}

#[test]
fn a_written_non_pdf_is_refused_not_cached() {
    let scratch = Scratch::new("not-a-pdf");

    struct GarbageSession;

    impl ConvertSession for GarbageSession {
        fn convert(&mut self, jobs: &[ConvertJob], _cancelled: &dyn Fn() -> bool) -> BatchOutcome {
            for job in jobs {
                fs::write(&job.output, "this is not a pdf").unwrap();
            }

            BatchOutcome::Done(jobs.iter().map(|_| Ok(())).collect())
        }

        fn finish(&mut self) {}
    }

    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let detected = Detected {
        engines: vec![EngineKind::Word, EngineKind::LibreOffice],
        soffice: None,
    };
    let opened = Cell::new(0);

    let entries = converter
        .resolve_with(
            &detected,
            &[scratch.document("garbage.docx", "contents")],
            &|| false,
            &mut || {},
            &|_, _, _| {
                opened.set(opened.get() + 1);

                if opened.get() == 1 {
                    Ok(Box::new(GarbageSession) as Box<dyn ConvertSession>)
                } else {
                    Ok(Box::new(FakeSession {
                        plan: word_engine(),
                        log: Arc::new(Mutex::new(Log::default())),
                        seen: 0,
                        stop_after: None,
                        stop_flag: None,
                    }))
                }
            },
        )
        .expect("a refusal is an answer");

    let pdf = match &entries[0] {
        Entry::Converted(pdf) => pdf.clone(),
        other => panic!("should have converted, not {other:?}"),
    };

    assert_eq!(
        fs::read_to_string(&pdf).expect("the cache entry is a real file"),
        "%PDF-1.7 (fake)"
    );
}

#[test]
fn the_same_path_twice_in_one_batch_is_one_conversion() {
    let scratch = Scratch::new("duplicate");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());
    let document = scratch.document("twice.docx", "just once");

    let (entries, log) = run(
        &converter,
        &[EngineKind::Word],
        &[document.clone(), document],
        &[word_engine()],
    );

    let results = converted(&entries.expect("both rows answer"));

    assert!(results[0].is_some());
    assert_eq!(results[0], results[1], "both rows read the same PDF");
    assert_eq!(log.lock().unwrap().conversions, 1);
}

// The PowerShell engine's whole result protocol rides the child's stdout, and
// `wait_with_output` reads nothing when nothing was piped — this pins that.
#[test]
fn a_child_answers_on_captured_stdout() {
    // `cmd` on Windows, where the engine lives; `sh` everywhere tests run.
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "echo probe-answer"]);
        command
    } else {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "echo probe-answer"]);
        command
    };

    let finished = super::run_with_timeout(&mut command, std::time::Duration::from_secs(10))
        .expect("a shell should run");

    assert!(!finished.timed_out);
    assert!(finished.output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&finished.output.stdout).trim(),
        "probe-answer",
    );
}

#[cfg(target_os = "linux")]
#[test]
fn versioned_opt_installs_are_listed_newest_first() {
    let scratch = Scratch::new("opt");

    for name in ["libreoffice7.6", "libreoffice24.8", "libreoffice26.2"] {
        let program = scratch.path().join(name).join("program");
        fs::create_dir_all(&program).expect("a program dir should be creatable");

        // Listing only: the caller checks executability, so plain files do.
        fs::write(program.join("soffice"), b"").expect("a soffice should be writable");
    }

    // Neither a TDF versioned install: the distro layout's own name, a
    // non-numeric suffix, and an unrelated directory that merely contains one.
    for name in ["libreoffice", "libreoffice-server", "writer-suite/program"] {
        let directory = scratch.path().join(name);
        fs::create_dir_all(&directory).expect("a dir should be creatable");
    }

    let versions: Vec<String> = libreoffice::versioned_opt_candidates(scratch.path())
        .iter()
        .filter_map(|soffice| {
            soffice
                .parent()
                .and_then(Path::parent)
                .and_then(|install| install.file_name())
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .collect();

    // Numeric, not lexicographic: 7.6 sorts below both 2x versions.
    assert_eq!(
        versions,
        ["libreoffice26.2", "libreoffice24.8", "libreoffice7.6"]
    );
}

#[test]
fn a_script_that_never_answered_names_why_on_stderr() {
    fn output(stderr: Vec<u8>) -> std::process::Output {
        std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: Vec::new(),
            stderr,
        }
    }

    // A quiet, successful silence is nobody's note.
    assert_eq!(super::unanswered_note(&output(Vec::new()), false), "");

    let refused = output(b"New-Object : COM class factory failed\r\n".to_vec());
    assert_eq!(
        super::unanswered_note(&refused, false),
        ": New-Object : COM class factory failed"
    );

    // A wall of red is trimmed to the first readable stretch.
    let wall = output(vec![b'x'; 500]);
    assert_eq!(super::unanswered_note(&wall, false).chars().count(), 202);
}

#[test]
fn a_killed_run_names_no_exit_status_of_its_own() {
    fn failure() -> std::process::ExitStatus {
        #[cfg(unix)]
        {
            std::os::unix::process::ExitStatusExt::from_raw(1 << 8)
        }

        #[cfg(windows)]
        {
            std::os::windows::process::ExitStatusExt::from_raw(1)
        }
    }

    let killed = std::process::Output {
        status: failure(),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };

    // The status a kill leaves behind is this app's doing, not the script's
    // reason; a run that died on its own still gets to name its exit status.
    assert_eq!(super::unanswered_note(&killed, true), "");
    assert_eq!(super::unanswered_note(&killed, false), ": exit status 1");
}
