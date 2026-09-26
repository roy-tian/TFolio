use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use super::*;
use crate::pdfium::archive::{ArchiveOptions, ImageFormat};
use crate::pdfium::archive_links::{collect_links, write_navigation};

struct Section {
    title: String,
    start: i32,
    end: i32,
}

fn sections(outline: &[PdfOutlineItem], pages: i32) -> Result<Vec<Section>, String> {
    let mut starts: Vec<_> = outline
        .iter()
        .filter_map(|item| {
            item.page_number
                .filter(|page| (1..=pages).contains(page))
                .map(|page| (page - 1, item.title.clone()))
        })
        .collect();
    starts.sort_by_key(|(page, _)| *page);
    starts.dedup_by_key(|(page, _)| *page);
    if starts.is_empty() {
        return Err("this document has no top-level bookmarks with page destinations".into());
    }
    if starts[0].0 > 0 {
        starts.insert(0, (0, String::new()));
    }
    Ok(starts
        .iter()
        .enumerate()
        .map(|(index, (start, title))| Section {
            title: title.clone(),
            start: *start,
            end: starts.get(index + 1).map_or(pages, |(page, _)| *page),
        })
        .collect())
}

fn section_name(index: usize, title: &str) -> String {
    let title: String = title
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let title = io::bounded_file_name(title.trim().trim_matches('.'));
    if title.is_empty() {
        format!("{:03}.pdf", index + 1)
    } else {
        format!("{:03}-{title}.pdf", index + 1)
    }
}

fn section_outline(items: &[PdfOutlineItem], start: i32, end: i32) -> Vec<OutlineNode> {
    items
        .iter()
        .flat_map(|item| {
            let children = section_outline(&item.items, start, end);
            match item.page_number {
                Some(page) if page > start && page <= end => vec![OutlineNode {
                    title: item.title.clone(),
                    page: (page - 1 - start) as usize,
                    children,
                }],
                _ => children,
            }
        })
        .collect()
}

// The bounds the engine enforces on its own: the dialog offers a few named
// densities, but a command's arguments are anyone's to send.
const MIN_IMAGE_DPI: u32 = 72;
const MAX_IMAGE_DPI: u32 = 600;

/// The viewer's render cap keeps a page under a bitmap any screen needs; an
/// export the reader explicitly aimed at print may grow to this, still bounded
/// so a poster page at 600 dpi cannot ask for pixels no desktop can hold.
const MAX_EXPORT_RENDER_WIDTH: i32 = 8192;
const MAX_EXPORT_RENDER_HEIGHT: i32 = 8192;

fn image_dpi(dpi: u32) -> Result<u32, String> {
    if (MIN_IMAGE_DPI..=MAX_IMAGE_DPI).contains(&dpi) {
        Ok(dpi)
    } else {
        Err(format!(
            "an image export needs between {MIN_IMAGE_DPI} and {MAX_IMAGE_DPI} dpi, not {dpi}"
        ))
    }
}

/// The zero-based page indices the reader's selection names, sorted and free of
/// repeats whatever order the sender listed them in.
fn selected_pages(pages: &[u32], total: i32) -> Result<Vec<usize>, String> {
    if pages.is_empty() {
        return Err("an image export needs at least one page".into());
    }
    let mut named: Vec<u32> = pages.to_vec();
    named.sort_unstable();
    named.dedup();
    if named[0] < 1 || named[named.len() - 1] > total as u32 {
        return Err(format!(
            "a page between 1 and {total} must be named, not {} to {}",
            named[0],
            named[named.len() - 1]
        ));
    }
    Ok(named.into_iter().map(|page| (page - 1) as usize).collect())
}

impl PdfiumEngine {
    pub(in crate::pdfium) fn export_archive(
        &self,
        document_id: u64,
        path: &Path,
        options: ArchiveOptions,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let operation = self.begin_operation(OperationTarget::Archive(document_id));
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;
        // A ZIP can never replace an open PDF, including one reached through an alias.
        if io::is_open_document_file(&documents, path, None) {
            return Err("an archive cannot replace an open PDF".into());
        }
        let source = &entry.document;
        let total = source.pages().len() as usize;
        let outline = collect_bookmark_siblings(source.bookmarks().root());
        let dpi = if let ArchiveOptions::Images { dpi, .. } = options {
            image_dpi(dpi)?
        } else {
            POINTS_PER_INCH as u32
        };
        let selected = if let ArchiveOptions::Images { pages, .. } = &options {
            Some(selected_pages(pages, total as i32)?)
        } else {
            None
        };
        let parts = if options == ArchiveOptions::Bookmarks {
            sections(&outline, total as i32)?
        } else {
            Vec::new()
        };
        // Progress counts what the archive will hold: every page for the two
        // document splits, the reader's own selection for images.
        let progress_total = selected.as_ref().map_or(total, Vec::len);
        on_progress(0, progress_total);
        io::write_file_atomically(path, |file| {
            let mut zip = ZipWriter::new(file);
            // Images and PDF streams are already compressed; store them without another buffer.
            let entry_options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(true);
            let failed = |error| format!("could not write ZIP archive: {error}");
            match options {
                ArchiveOptions::Bookmarks => {
                    for (index, section) in parts.iter().enumerate() {
                        if operation.is_cancelled() {
                            return Ok(false);
                        }
                        let mut part = self
                            .pdfium
                            .create_new_pdf()
                            .map_err(|error| format!("could not create a split PDF: {error}"))?;
                        let mut links = Vec::new();
                        for page in section.start..section.end {
                            if operation.is_cancelled() {
                                return Ok(false);
                            }
                            let source_page = source
                                .pages()
                                .get(page)
                                .map_err(|error| format!("could not read page links: {error}"))?;
                            links.push(collect_links(&source_page)?);
                            part.pages_mut()
                                .copy_page_from_document(source, page, page - section.start)
                                .map_err(|error| {
                                    format!("could not copy page {}: {error}", page + 1)
                                })?;
                            on_progress((page + 1) as usize, total);
                        }
                        let bytes = part
                            .save_to_bytes()
                            .map_err(|error| format!("could not save a split PDF: {error}"))?;
                        let Some(bytes) = write_navigation(
                            bytes,
                            &section_outline(&outline, section.start, section.end),
                            &links,
                            section.start,
                            || operation.is_cancelled(),
                        )?
                        else {
                            return Ok(false);
                        };
                        zip.start_file(section_name(index, &section.title), entry_options)
                            .map_err(failed)?;
                        zip.write_all(&bytes)
                            .map_err(|error| format!("could not write split PDF: {error}"))?;
                    }
                }
                ArchiveOptions::Pages => {
                    for page in 0..source.pages().len() {
                        if operation.is_cancelled() {
                            return Ok(false);
                        }
                        let mut part = self
                            .pdfium
                            .create_new_pdf()
                            .map_err(|error| format!("could not create a split PDF: {error}"))?;
                        part.pages_mut()
                            .copy_page_from_document(source, page, 0)
                            .map_err(|error| {
                                format!("could not copy page {}: {error}", page + 1)
                            })?;
                        let bytes = part
                            .save_to_bytes()
                            .map_err(|error| format!("could not save a split PDF: {error}"))?;
                        // No navigation to restore: a single page carries no
                        // outline of its own, and every link off it is dropped.
                        zip.start_file(format!("{:04}.pdf", page + 1), entry_options)
                            .map_err(failed)?;
                        zip.write_all(&bytes)
                            .map_err(|error| format!("could not write split PDF: {error}"))?;
                        on_progress(page as usize + 1, total);
                    }
                }
                ArchiveOptions::Images { image_format, .. } => {
                    // Names follow the document's own numbering, so a selection
                    // keeps the numbers the reader sees under each thumbnail.
                    for (done, &page) in selected.as_deref().unwrap_or_default().iter().enumerate()
                    {
                        if operation.is_cancelled() {
                            return Ok(false);
                        }
                        let page_handle = source.pages().get(page as i32).map_err(|error| {
                            format!("could not load page {}: {error}", page + 1)
                        })?;
                        let config = PdfRenderConfig::new()
                            .scale_page_by_factor(dpi as f32 / POINTS_PER_INCH)
                            .set_maximum_width(MAX_EXPORT_RENDER_WIDTH)
                            .set_maximum_height(MAX_EXPORT_RENDER_HEIGHT)
                            .render_annotations(true)
                            .render_form_data(true);
                        let pixels = page_handle
                            .render_with_config(&config)
                            .and_then(|bitmap| bitmap.as_image())
                            .map_err(|error| {
                                format!("could not render page {}: {error}", page + 1)
                            })?
                            .into_rgb8();
                        let extension = if image_format == ImageFormat::Jpg {
                            "jpg"
                        } else {
                            "png"
                        };
                        zip.start_file(format!("{:04}.{extension}", page + 1), entry_options)
                            .map_err(failed)?;
                        if image_format == ImageFormat::Jpg {
                            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut zip, 95)
                                .encode_image(&pixels)
                        } else {
                            image::ImageEncoder::write_image(
                                image::codecs::png::PngEncoder::new(&mut zip),
                                &pixels,
                                pixels.width(),
                                pixels.height(),
                                image::ExtendedColorType::Rgb8,
                            )
                        }
                        .map_err(|error| format!("could not encode page {}: {error}", page + 1))?;
                        on_progress(done + 1, progress_total);
                    }
                }
            }
            if operation.is_cancelled() {
                return Ok(false);
            }
            zip.finish().map_err(failed)?;
            Ok(!operation.is_cancelled())
        })
    }
}
