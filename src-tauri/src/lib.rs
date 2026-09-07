mod launch;
mod pdfium;
mod recent;
mod settings;
mod store;
mod windows;

use launch::{take_launch_pdfs, LaunchQueue};
use pdfium::{
    add_pdf_highlight_annotation, add_pdf_rect_annotation, add_pdf_rect_effect_annotation,
    add_pdf_text_note_annotation, apply_pdf_page_numbers, apply_pdf_watermark, cancel_pdf_merge,
    cancel_pdf_operation, cancel_pdf_search, close_pdf, create_pdf, delete_pdf_annotations,
    delete_pdf_pages, download_pdf_note_font, export_pdf, extract_pdf_page_text,
    insert_pdf_blank_page, insert_pdf_from_path, inspect_pdf_files, merge_pdf_files, open_pdf,
    open_pdf_from_path, pdf_annotation_at_point, pick_pdf_path, pick_pdf_paths,
    remove_pdf_page_numbers, remove_pdf_watermark, render_pdf_page, render_pdf_page_thumbnail,
    reorder_pdf_pages, restore_pdf_pages, save_pdf, search_pdf_text, PdfiumState,
};
use recent::{recent_pdf_view, recent_pdfs, set_recent_pdf_view, RecentFiles};
use settings::{set_settings, settings};
use tauri::Manager;
use windows::{focus_pdf_path, open_new_window, AppWindows, DocumentOwners};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered first, because a second instance's whole job is to hand over
    // the file it was launched with and exit: anything set up ahead of that is
    // work a process about to die did for nothing. Double-clicking a PDF while
    // TFolio is open belongs in the window already showing the reader's other
    // tabs — and two processes would keep two versions of one recent list.
    //
    // macOS needs none of it: Finder activates the running app and sends the
    // file to it, which arrives below as `RunEvent::Opened`. Nor does the e2e
    // build, which is the one binary that really is run again and again: a
    // session outliving its spec would kill the next spec's app rather than
    // its own.
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

        // A name of its own for a build that is not the installed app.
        // Otherwise `tauri dev`, started while an installed TFolio is open,
        // hands its arguments to that copy and exits — no window, no message,
        // and only when the other one happens to be running. Linux alone: the
        // D-Bus name is the only one the plugin lets an app choose.
        #[cfg(debug_assertions)]
        let single_instance = single_instance.dbus_id("com.roytian.tfolio.dev");

        builder.plugin(single_instance.build())
    };

    let builder = builder.plugin(tauri_plugin_dialog::init());

    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            let pdfium = PdfiumState::new(app.handle()).map_err(std::io::Error::other)?;
            // An earlier run's recent list is the one thing outside this
            // process that may name a path the reader gets to reopen, and it
            // holds only paths a dialog or a drop produced while this app
            // watched — so approving it is approving the reader's own past
            // gestures, not the WebView's word.
            let recent = RecentFiles::load(app.handle());
            pdfium.approve_paths(recent.stored().iter());
            app.manage(pdfium);
            app.manage(recent);
            app.manage(settings::load(app.handle()));
            app.manage(LaunchQueue::default());
            app.manage(AppWindows::default());
            app.manage(DocumentOwners::default());
            // The file a double-click in the file manager launched this run
            // for. It waits here for the workspace, which takes it as soon as
            // there is one to open it in.
            launch::queue_open(app.handle(), launch::pdf_paths_from_this_launch());
            Ok(())
        })
        // Reloading replaces the page without destroying its window, leaving its documents unreachable.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                windows::release_window(webview.app_handle(), webview.label());
            }
        })
        // Recorded on the Rust side of the boundary, because this is the only
        // place a drop's paths exist before the WebView has touched them:
        // `open_pdf_from_path` only acts on paths approved here or by the
        // dialog in `pick_pdf_path`.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                if let Some(state) = window.try_state::<PdfiumState>() {
                    state.approve_paths(paths.iter());
                }
            }
            tauri::WindowEvent::Focused(true) => {
                windows::remember_focus(window.app_handle(), window.label())
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
            settings,
            set_settings,
            take_launch_pdfs,
            open_new_window,
            focus_pdf_path,
            reorder_pdf_pages,
            delete_pdf_pages,
            restore_pdf_pages,
            insert_pdf_blank_page,
            insert_pdf_from_path,
            save_pdf,
            export_pdf,
            close_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while running TFolio")
        // Built and run in two steps for the one event below, which no builder
        // hook reports.
        .run(|_app, _event| {
            // Finder activates the app, which may raise a different window or leave the target minimized.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(window) = launch::queue_open(_app, launch::pdf_paths_from_urls(&urls)) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}
