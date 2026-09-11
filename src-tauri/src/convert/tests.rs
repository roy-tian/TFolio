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

/// A scratch directory the test owns outright, removed however the test ends.
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

/// What the fake engines did, in order — the assertions read it like a log.
#[derive(Default)]
struct Log {
    opened: Vec<&'static str>,
    conversions: usize,
    finished: usize,
}

/// What one fake engine is: what it refuses, how many files it answers
/// before giving up on the rest, or whether it never runs at all.
#[derive(Clone)]
struct EnginePlan {
    name: &'static str,
    /// Input contents this engine refuses, as per-file failures.
    refuses: Vec<&'static str>,
    /// Answers this many files; the rest come back unfinished — the shape a
    /// killed script run has, not a broken engine.
    answers_before_stopping: Option<usize>,
    /// Cannot even be started; the whole batch moves on untried.
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

/// One run of the chain over sessions a test describes, handing back both the
/// per-file answers and the log of what the chain actually did.
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
    // A drive-prefixed Windows path is absolute without a leading slash; the
    // URL grammar still wants three.
    assert_eq!(
        libreoffice::file_url(Path::new(r"C:\Users\R OY\o.docx")),
        "file:///C:/Users/R%20OY/o.docx"
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

    // Same file facts: one conversion, and the second answer names the very
    // PDF the first wrote, without reaching for the engine again.
    let first_entry = converted(&first.expect("the first run converts"));

    assert_eq!(
        first_entry,
        converted(&second.expect("the cached run is served"))
    );
    assert_eq!(first_log.lock().unwrap().conversions, 1);
    assert_eq!(second_log.lock().unwrap().opened.len(), 0);

    // A longer draft is different facts — the cache must not answer for it.
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

    // One session per engine that ran; the one that never ran finished none.
    let log = log.lock().unwrap();

    assert_eq!(log.opened, vec!["word", "libreoffice"]);
    assert_eq!(log.conversions, 2);
}

#[test]
fn files_a_killed_run_left_unfinished_reach_the_next_engine() {
    let scratch = Scratch::new("unfinished");
    let converter = WordConverter::at_directory(scratch.path().to_path_buf());

    // Word answers one file and is then killed for taking too long: the
    // first file keeps its answer, the second rides on.
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

    // Asked once per file while the batch is gathered: the second ask is the
    // reader's stop arriving between two files.
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

    // The first file's conversion outlived the stop in the cache: a run
    // that tries again reaches for the engine once, for the second file.
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

    // A session whose output is not a PDF: refused, never handed to PDFium
    // — and the next engine still gets its chance.
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

                // The first engine writes garbage; the second converts.
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

    // The garbage never became a cache entry, and the second engine's PDF is
    // what the file ends up read from.
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
