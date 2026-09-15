mod convert;
mod launch;
mod pdfium;
mod recent;
mod settings;
mod store;
mod update;
mod window_state;
mod windows;

use convert::word_conversion_available;
use launch::{take_launch_pdfs, LaunchQueue};
use pdfium::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_archive,
    cancel_pdf_merge, cancel_pdf_operation, cancel_pdf_search, cancel_word_conversion, close_pdf,
    create_pdf, delete_pdf_annotations, delete_pdf_pages, download_pdf_note_font,
    duplicate_pdf_pages, export_pdf, export_pdf_archive, extract_pdf_page_plain_text,
    extract_pdf_page_text, insert_pdf_blank_page, insert_pdf_from_path,
    insert_pdf_pages_from_document, inspect_pdf_files, merge_pdf_files, open_converted_from_path,
    open_pdf, open_pdf_from_path, pdf_annotation_at_point, pick_pdf_path, pick_pdf_paths,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    reorder_pdf_pages, restore_pdf_pages, rotate_pdf_pages, save_pdf, search_pdf_text, PdfiumState,
};
use recent::{recent_pdf_view, recent_pdfs, set_recent_pdf_view, RecentFiles};
use settings::{set_settings, settings};
use tauri::Manager;
use update::{download_update, install_update, update_status, UpdateState};
use window_state::WindowState;
use windows::{focus_pdf_path, open_new_window, print_window, AppWindows, DocumentOwners};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered first: a second instance just hands its file over and exits.
    // macOS needs none of it (RunEvent::Opened), nor the per-spec e2e run.
    #[cfg(all(not(feature = "e2e"), any(target_os = "linux", target_os = "windows")))]
    let builder = {
        let single_instance =
            tauri_plugin_single_instance::Builder::new().callback(|app, argv, cwd| {
                let target = launch::queue_open(
                    app,
                    launch::pdf_paths_from_args(
                        argv.into_iter().skip(1),
                        std::path::Path::new(&cwd),
                    ),
                )
                .or_else(|| windows::focus_target(app));

                if let Some(window) = target {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });

        // A dev-only D-Bus name, or `tauri dev` hands its arguments to a
        // running installed copy and exits. Linux alone allows choosing one.
        #[cfg(debug_assertions)]
        let single_instance = single_instance.dbus_id("com.roytian.tfolio.dev");

        builder.plugin(single_instance.build())
    };

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            let pdfium = PdfiumState::new(app.handle()).map_err(std::io::Error::other)?;
            // The recent list holds only paths a dialog or drop produced
            // while this app watched, so approving it approves past gestures.
            let recent = RecentFiles::load(app.handle());
            pdfium.approve_paths(recent.stored().iter());
            app.manage(pdfium);
            app.manage(recent);
            app.manage(settings::load(app.handle()));
            app.manage(LaunchQueue::default());
            app.manage(AppWindows::default());
            app.manage(DocumentOwners::default());
            app.manage(UpdateState::default());
            app.manage(WindowState::load(app.handle()));
            // Not in the GUI suite: a spec may not reach the network, and
            // nothing a spec drives may install anything over this build.
            #[cfg(not(feature = "e2e"))]
            update::check_in_background(app.handle());
            // This run's launch files wait here for a workspace to open them.
            launch::queue_open(app.handle(), launch::pdf_paths_from_this_launch());
            // Last, because it is what shows `main`: everything above runs
            // behind the config's hidden first frame.
            window_state::restore(app.handle());
            Ok(())
        })
        // Reloading replaces the page without destroying its window or closing documents.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                windows::release_window(webview.app_handle(), webview.label());
            }
        })
        // The only place a drop's paths exist before the WebView touches
        // them; `open_pdf_from_path` acts only on paths approved here or by a dialog.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                if let Some(state) = window.try_state::<PdfiumState>() {
                    state.approve_paths(paths.iter());
                }
            }
            tauri::WindowEvent::Focused(true) => {
                windows::remember_focus(window.app_handle(), window.label());
                window_state::remember(window.app_handle(), window)
            }
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                window_state::remember(window.app_handle(), window)
            }
            tauri::WindowEvent::Destroyed => {
                windows::window_gone(window.app_handle(), window.label())
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            create_pdf,
            open_pdf,
            open_pdf_from_path,
            open_converted_from_path,
            pick_pdf_path,
            pick_pdf_paths,
            inspect_pdf_files,
            merge_pdf_files,
            recent_pdfs,
            recent_pdf_view,
            set_recent_pdf_view,
            render_pdf_page,
            render_pdf_page_thumbnail,
            extract_pdf_page_text,
            extract_pdf_page_plain_text,
            search_pdf_text,
            cancel_pdf_search,
            add_pdf_highlight_annotation,
            add_pdf_rect_annotation,
            add_pdf_rect_effect_annotation,
            add_pdf_text_note_annotation,
            download_pdf_note_font,
            apply_pdf_watermark,
            delete_pdf_annotations,
            pdf_annotation_at_point,
            remove_pdf_watermark,
            apply_pdf_page_numbers,
            remove_pdf_page_numbers,
            cancel_pdf_operation,
            cancel_pdf_merge,
            cancel_word_conversion,
            word_conversion_available,
            settings,
            set_settings,
            update_status,
            download_update,
            install_update,
            take_launch_pdfs,
            open_new_window,
            print_window,
            focus_pdf_path,
            reorder_pdf_pages,
            rotate_pdf_pages,
            delete_pdf_pages,
            restore_pdf_pages,
            insert_pdf_blank_page,
            insert_pdf_from_path,
            insert_pdf_pages_from_document,
            duplicate_pdf_pages,
            save_pdf,
            export_pdf,
            export_pdf_archive,
            cancel_pdf_archive,
            close_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while running TFolio")
        // Built and run in two steps for the one event below, which no builder
        // hook reports.
        .run(|_app, _event| {
            // The tail of a resize the write throttle may still be holding.
            if let tauri::RunEvent::Exit = _event {
                window_state::flush(_app);
            }

            // Finder may raise a different window or leave the target minimized.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(window) = launch::queue_open(_app, launch::pdf_paths_from_urls(&urls)) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}
