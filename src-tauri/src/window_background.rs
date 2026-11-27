use serde::Serialize;
use tauri::WebviewWindow;

/// Native window material active beneath the WebView, named for the frontend's
/// platform-specific surface rules (`data-native-material`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceMaterial {
    /// macOS Liquid Glass (or vibrancy fallback on older macOS).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Glass,
    /// Windows 11 DWM Mica (`DWMSBT_MAINWINDOW`).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Mica,
}

/// Only reveal the desktop after the native material has been installed.
#[tauri::command]
pub async fn set_workspace_background(
    window: WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<Option<WorkspaceMaterial>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let native_window = window.clone();

        // AppKit views must be created on the main thread, including on reload
        // and when a new workspace boots through this same command.
        window
            .run_on_main_thread(move || {
                let _ = sender.try_send(apply_background(&native_window, dark, follow_system));
            })
            .map_err(|error| error.to_string())?;

        receiver
            .recv()
            .await
            .ok_or_else(|| "the window closed before its background was ready".to_string())?
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, dark, follow_system);
        Ok(None)
    }
}

/// The first build with `DWMWA_SYSTEMBACKDROP_TYPE`, window-vibrancy's own test.
#[cfg(target_os = "windows")]
const SYSTEM_BACKDROP_BUILD: u32 = 22523;

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn apply_background(
    window: &WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<Option<WorkspaceMaterial>, String> {
    #[cfg(target_os = "windows")]
    {
        let theme = if follow_system {
            None
        } else if dark {
            Some(tauri::Theme::Dark)
        } else {
            Some(tauri::Theme::Light)
        };
        window.set_theme(theme).map_err(|error| error.to_string())?;

        // Without the documented system backdrop (Windows 10, Windows 11 21H2),
        // borderless windows avoid undocumented DWM attributes and stay opaque.
        if windows_version::OsVersion::current().build < SYSTEM_BACKDROP_BUILD {
            return Ok(None);
        }

        // Always pass the resolved dark flag so switching back to system theme
        // updates DWMWA_USE_IMMERSIVE_DARK_MODE after a manual override.
        window_vibrancy::apply_mica(window, Some(dark)).map_err(|error| error.to_string())?;
        Ok(Some(WorkspaceMaterial::Mica))
    }

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
            NSAppearanceNameDarkAqua, NSWindow,
        };
        use window_vibrancy::{
            apply_liquid_glass, apply_vibrancy, clear_liquid_glass, clear_vibrancy, Error,
            LiquidGlassOptions, NSVisualEffectMaterial,
        };

        // Tauri's macOS set_theme changes the whole app. A window may still
        // use the preference it booted with while another changes its theme.
        let appearance = if follow_system {
            None
        } else {
            let name = unsafe {
                if dark {
                    NSAppearanceNameDarkAqua
                } else {
                    NSAppearanceNameAqua
                }
            };
            NSAppearance::appearanceNamed(name)
        };
        let native_window = window.ns_window().map_err(|error| error.to_string())?;
        // The handle belongs to this live window; this runs on AppKit's thread.
        unsafe { &*native_window.cast::<NSWindow>() }.setAppearance(appearance.as_deref());

        // Reloads and theme changes reuse the native window; remove its old
        // view so materials do not accumulate underneath the WebView.
        clear_liquid_glass(window).map_err(|error| error.to_string())?;
        clear_vibrancy(window).map_err(|error| error.to_string())?;

        match apply_liquid_glass(window, LiquidGlassOptions::default()) {
            Ok(()) => {}
            Err(Error::UnsupportedPlatformVersion(_)) => {
                apply_vibrancy(
                    window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }

        Ok(Some(WorkspaceMaterial::Glass))
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceMaterial;

    #[test]
    fn serializes_workspace_material_names_for_frontend() {
        assert_eq!(
            serde_json::to_string(&WorkspaceMaterial::Glass).unwrap(),
            "\"glass\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceMaterial::Mica).unwrap(),
            "\"mica\""
        );
    }
}
