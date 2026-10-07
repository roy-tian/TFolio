use tauri::WebviewWindow;

/// Only reveal the desktop after the native material has been installed.
#[tauri::command]
pub async fn set_workspace_background(
    window: WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<bool, String> {
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
        Ok(false)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn apply_background(
    window: &WebviewWindow,
    dark: bool,
    follow_system: bool,
) -> Result<bool, String> {
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

        let tint = if dark {
            (9, 9, 11, 180)
        } else {
            (244, 244, 245, 180)
        };
        window_vibrancy::apply_acrylic(window, Some(tint)).map_err(|error| error.to_string())?;
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
    }

    Ok(true)
}
