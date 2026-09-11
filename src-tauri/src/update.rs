//! The run's one release check, process-wide: two windows would install whichever
//! fetched last. Its commands carry no argument, so no page names the endpoint or key.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Named on both sides of the boundary; the two have to be changed together.
pub const UPDATE_CHANGED_EVENT: &str = "update://changed";

const NOT_READY_ERROR: &str = "tfolio:update-not-ready";
const DEBUG_BUILD_ERROR: &str = "tfolio:update-not-installable";
const NO_CACHE_ERROR: &str = "tfolio:update-no-cache-directory";
const UNVERIFIED_ERROR: &str = "tfolio:update-package-unverified";

/// Read whole to be verified; nothing on disk is to be trusted about its length.
const MAX_PACKAGE_BYTES: u64 = 512 << 20;

/// Cache, not the data directory beside `settings.toml`: the installer is large
/// and disposable, and everything there is small, kept, and theirs to edit.
const UPDATES_DIRECTORY: &str = "updates";

/// Fixed rather than taken from the release. The only name on offer comes from
/// the feed, and a name off the network has no business shaping a path.
const PACKAGE_FILE_NAME: &str = "pending";
const SIGNATURE_FILE_NAME: &str = "pending.json";

const UNMEASURED_STEP_BYTES: u64 = 1 << 20;

/// What every window is showing, in the shape `src/lib/update.ts` reads: a check
/// that could not reach the endpoint is `Idle` too — not news to one who never asked.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Available {
        version: String,
    },
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    Ready {
        version: String,
    },
    Failed {
        version: String,
    },
}

/// The signature this run's own fetch of the feed named for the bytes. No
/// version is kept: disk's word could pass a signed older release off as new.
#[derive(Clone, Deserialize, Serialize)]
struct Package {
    signature: String,
}

#[derive(Default)]
pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    /// What the check found. Kept past the download as well: installing needs
    /// the same handle that verified the bytes.
    pending: Mutex<Option<Update>>,
    package: Mutex<Option<Package>>,
    /// Held for the length of one download, so a second window's button joins
    /// the download already running instead of starting another.
    downloading: AtomicBool,
    /// Held for the length of one install, so a second press cannot hand the same
    /// package to the platform twice while the first waits on its root prompt.
    installing: AtomicBool,
}

impl UpdateState {
    fn publish(&self, app: &AppHandle, status: UpdateStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }

        let _ = app.emit(UPDATE_CHANGED_EVENT, status);
    }

    fn snapshot(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    fn pending(&self) -> Option<Update> {
        self.pending.lock().ok().and_then(|pending| pending.clone())
    }
}

fn updates_directory(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|directory| directory.join(UPDATES_DIRECTORY))
}

/// Read out of the embedded configuration: compiled in, so nothing on the
/// machine can aim the check at a key of its own.
fn release_key(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_string)
}

/// Both the key and the signature reach this app base64-wrapped around the text
/// of a minisign file, which is how the plugin's own check unwraps them too.
fn unwrap_base64(value: &str) -> Option<String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()?;

    String::from_utf8(decoded).ok()
}

fn verify(bytes: &[u8], signature: &str, key: &str) -> Result<(), String> {
    let key = unwrap_base64(key).and_then(|key| PublicKey::decode(&key).ok());
    let signature =
        unwrap_base64(signature).and_then(|signature| Signature::decode(&signature).ok());

    let (Some(key), Some(signature)) = (key, signature) else {
        return Err(UNVERIFIED_ERROR.into());
    };

    key.verify(bytes, &signature, true)
        .map_err(|_| UNVERIFIED_ERROR.to_string())
}

fn discard_package(app: &AppHandle) {
    if let Some(directory) = updates_directory(app) {
        let _ = fs::remove_dir_all(directory);
    }
}

#[cfg_attr(feature = "e2e", allow(dead_code))]
fn saved_package(app: &AppHandle) -> Option<Package> {
    let sidecar = updates_directory(app)?.join(SIGNATURE_FILE_NAME);
    let contents = fs::read_to_string(sidecar).ok()?;

    serde_json::from_str(&contents).ok()
}

/// Created owner-only from the first moment: chmod after the fact would leave a
/// umask window on a file later handed to an installer with more rights.
#[cfg(unix)]
fn write_privately(directory: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::{
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };

    let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    // Removed first, because `mode` applies only to a file this call creates:
    // an existing one would keep whatever permissions it already had.
    let _ = fs::remove_file(path);

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

#[cfg(not(unix))]
fn write_privately(_directory: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(path, bytes)
}

fn store_package(app: &AppHandle, bytes: &[u8], package: &Package) -> Result<(), String> {
    let directory = updates_directory(app).ok_or(NO_CACHE_ERROR)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let path = directory.join(PACKAGE_FILE_NAME);
    write_privately(&directory, &path, bytes).map_err(|error| error.to_string())?;

    let sidecar = serde_json::to_string(package).map_err(|error| error.to_string())?;
    fs::write(directory.join(SIGNATURE_FILE_NAME), sidecar).map_err(|error| error.to_string())
}

fn read_package(app: &AppHandle, package: &Package) -> Result<Vec<u8>, String> {
    let (Some(directory), Some(key)) = (updates_directory(app), release_key(app)) else {
        return Err(NOT_READY_ERROR.into());
    };

    let path = directory.join(PACKAGE_FILE_NAME);
    let length = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();

    if length > MAX_PACKAGE_BYTES {
        return Err(UNVERIFIED_ERROR.into());
    }

    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    verify(&bytes, &package.signature, &key)?;

    Ok(bytes)
}

/// In the background: opening a file must not wait on the network. Never called
/// in the GUI build, which makes no request of its own.
#[cfg_attr(feature = "e2e", allow(dead_code))]
pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        // Read before the request and judged after it: what an earlier run left
        // behind counts only if this run is offered the very same bytes.
        let saved = saved_package(&app);
        let Ok(updater) = app.updater() else {
            return;
        };

        let update = match updater.check().await {
            Ok(Some(update)) => update,
            // Nothing newer, so a saved installer is for a release this one is
            // already past — most likely the one it installed.
            Ok(None) => return discard_package(&app),
            // No answer is not an answer about the saved package either, so it
            // stays where it is for the next run to ask about.
            Err(_) => return,
        };

        let version = update.version.clone();
        // The feed's own signature for this release, fetched this run: the saved
        // copy is measured against it, never against anything the disk says.
        let offered = update.signature.clone();
        let state = app.state::<UpdateState>();

        if let Ok(mut pending) = state.pending.lock() {
            *pending = Some(update);
        }

        // Off the async runtime: the reread is a whole-file read, and every
        // command issued while the workspace loads shares those worker threads.
        let restored = match saved.filter(|package| package.signature == offered) {
            Some(package) => {
                let verifier = app.clone();
                let candidate = package.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    read_package(&verifier, &candidate).is_ok()
                })
                .await
                .unwrap_or(false)
                .then_some(package)
            }
            None => None,
        };

        let status = match restored {
            Some(package) => {
                if let Ok(mut held) = state.package.lock() {
                    *held = Some(package);
                }

                UpdateStatus::Ready { version }
            }
            None => {
                discard_package(&app);
                UpdateStatus::Available { version }
            }
        };

        state.publish(&app, status);
    });
}

/// The check runs before there is a page to hear it, so a window asks once on
/// load and then follows [`UPDATE_CHANGED_EVENT`].
#[tauri::command]
pub async fn update_status(state: State<'_, UpdateState>) -> Result<UpdateStatus, String> {
    Ok(state.snapshot())
}

/// Writes the signature beside the bytes, so a run that ends before the install
/// does not throw the download away.
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();

    // Already here, or already on its way in another window: either way this
    // press has nothing of its own to start.
    let claimed = state.package.lock().is_ok_and(|package| package.is_none())
        && state
            .downloading
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();

    if !claimed {
        return Ok(());
    }

    let Some(update) = state.pending() else {
        state.downloading.store(false, Ordering::Release);
        return Ok(());
    };

    let version = update.version.clone();
    state.publish(
        &app,
        UpdateStatus::Downloading {
            version: version.clone(),
            received: 0,
            total: None,
        },
    );

    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut received = 0_u64;
    // No step announced yet, so the first chunk always reports — that is the
    // one carrying the length the bar needs to become determinate.
    let mut announced = u64::MAX;
    let downloaded = update
        .download(
            move |chunk, total| {
                received = received.saturating_add(chunk as u64);
                let step = total
                    .filter(|length| *length > 0)
                    .map_or(received / UNMEASURED_STEP_BYTES, |length| {
                        received.saturating_mul(100) / length
                    });

                // A chunk is a few kilobytes; only a change the reader could
                // see is worth waking every window for.
                if step == announced {
                    return;
                }

                announced = step;
                progress_app.state::<UpdateState>().publish(
                    &progress_app,
                    UpdateStatus::Downloading {
                        version: progress_version.clone(),
                        received,
                        total,
                    },
                );
            },
            || {},
        )
        .await;

    // Released before the result is read, so a download that failed can be
    // asked for again.
    state.downloading.store(false, Ordering::Release);

    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => {
            state.publish(&app, UpdateStatus::Failed { version });
            return Err(error.to_string());
        }
    };

    let package = Package {
        signature: update.signature.clone(),
    };
    let stored = store_package(&app, &bytes, &package).is_ok()
        && state
            .package
            .lock()
            .map(|mut held| *held = Some(package))
            .is_ok();

    state.publish(
        &app,
        if stored {
            UpdateStatus::Ready { version }
        } else {
            UpdateStatus::Failed { version }
        },
    );

    Ok(())
}

/// Installing restarts the process: everything every window has not written is
/// gone, which is why the button that reaches this asks first.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // Nothing in `target/` carries the bundle type the bundler patches in, so the
    // plugin would fall back to replacing this running binary with the release's bytes.
    if cfg!(debug_assertions) {
        return Err(DEBUG_BUILD_ERROR.into());
    }

    let state = app.state::<UpdateState>();

    if state
        .installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }

    let outcome = install_verified_package(&app).await;
    // Only a refusal reaches here: an install that took has already replaced
    // this process.
    state.installing.store(false, Ordering::Release);

    outcome
}

async fn install_verified_package(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let held = state
        .package
        .lock()
        .ok()
        .and_then(|package| package.clone());

    let (Some(update), Some(package)) = (state.pending(), held) else {
        return Err(NOT_READY_ERROR.into());
    };

    // Both steps block and neither is quick; neither may hold an async worker
    // the rest of the app shares.
    let verifier = app.clone();
    let candidate = package.clone();
    let read = tauri::async_runtime::spawn_blocking(move || read_package(&verifier, &candidate))
        .await
        .map_err(|error| format!("update verification task failed: {error}"))?;

    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            // A file that no longer answers to its signature is not an installer
            // any more; drop it so the next press fetches the release again.
            discard_package(app);
            if let Ok(mut held) = state.package.lock() {
                *held = None;
            }

            state.publish(
                app,
                UpdateStatus::Failed {
                    version: update.version.clone(),
                },
            );

            return Err(error);
        }
    };

    // Left where it is on a refusal: a second press should install what is
    // already downloaded rather than fetch it again.
    let installed = tauri::async_runtime::spawn_blocking(move || {
        update.install(&bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("update install task failed: {error}"))?;

    installed?;

    // The single-instance guard still holds the name `restart`'s replacement
    // will ask for; released here, on exactly the platforms that took it.
    #[cfg(all(not(feature = "e2e"), any(target_os = "linux", target_os = "windows")))]
    tauri_plugin_single_instance::destroy(app);

    // Windows hands off to its own installer and never comes back here.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read as the frontend reads it, so this pins the wire names rather than
    /// the variants they are spelled from.
    fn wire(status: UpdateStatus) -> serde_json::Value {
        serde_json::to_value(status).expect("a status should serialize")
    }

    #[test]
    fn a_quiet_run_says_only_that_it_is_idle() {
        assert_eq!(
            wire(UpdateStatus::default()),
            serde_json::json!({"state": "idle"})
        );
    }

    #[test]
    fn every_step_carries_the_version_under_its_own_state() {
        assert_eq!(
            wire(UpdateStatus::Available {
                version: "1.2.3".into()
            }),
            serde_json::json!({"state": "available", "version": "1.2.3"})
        );
        assert_eq!(
            wire(UpdateStatus::Ready {
                version: "1.2.3".into()
            }),
            serde_json::json!({"state": "ready", "version": "1.2.3"})
        );
        assert_eq!(
            wire(UpdateStatus::Failed {
                version: "1.2.3".into()
            }),
            serde_json::json!({"state": "failed", "version": "1.2.3"})
        );
    }

    /// The real release key, and a real signature over `PACKAGE` — the check a
    /// saved installer actually faces, not a stand-in for it.
    const RELEASE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE5RkU3Q0IwMkFBMUJFMzcKUldRM3ZxRXFzSHorcVZXYXc1SFYxbDNDNnhqL3ZHcDlQZVhlSUUrUHQ2VDM3ZDk2aHlQc2MwRSsK";
    const PACKAGE: &[u8] = b"an installer";
    const PACKAGE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRM3ZxRXFzSHorcWJiS29zaVNWZVcxdUs5WGhLUWFTaWFlZ2s3VDFYVXdmeEF3SzB0ZUZvaC95bER4Njhid01wVnhYaVhHVlc3QjVNaldMSGVmRzZlclkrMzBvWXl4Z2dzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg4OTc3NzYxCWZpbGU6YmxvYgpZUU9lY3ZXaDFCbnFNVk4yZHhzUGdSc3FCTnNySHRMZFFhcnpkOUV4cVNUUThhcTdYUHpjNHdNK0FyZzJhQkFaeld0TjZiWExZSzVDMHpyMW5ZeFVCdz09Cg==";

    #[test]
    fn a_saved_package_answers_to_the_release_key() {
        assert_eq!(verify(PACKAGE, PACKAGE_SIGNATURE, RELEASE_KEY), Ok(()));
    }

    /// The one check between a swapped file and an installer that may be
    /// running as root.
    #[test]
    fn a_saved_package_edited_after_the_download_is_refused() {
        assert_eq!(
            verify(b"something else", PACKAGE_SIGNATURE, RELEASE_KEY),
            Err(UNVERIFIED_ERROR.to_string())
        );
    }

    #[test]
    fn a_package_with_nothing_readable_behind_it_is_refused() {
        assert_eq!(
            verify(PACKAGE, "not base64 at all", RELEASE_KEY),
            Err(UNVERIFIED_ERROR.to_string())
        );
    }

    /// The sidecar is this app's own file, so its shape is worth pinning: a
    /// package saved by one run has to read back in the next.
    #[test]
    fn the_saved_signature_round_trips_through_its_sidecar() {
        let written = serde_json::to_string(&Package {
            signature: PACKAGE_SIGNATURE.into(),
        })
        .expect("the sidecar should serialize");
        let read: Package = serde_json::from_str(&written).expect("it should read back");

        assert_eq!(read.signature, PACKAGE_SIGNATURE);
    }

    #[test]
    fn a_download_of_unannounced_length_leaves_its_total_out() {
        assert_eq!(
            wire(UpdateStatus::Downloading {
                version: "1.2.3".into(),
                received: 4096,
                total: None,
            }),
            serde_json::json!({
                "state": "downloading", "version": "1.2.3", "received": 4096, "total": null
            })
        );
    }
}
