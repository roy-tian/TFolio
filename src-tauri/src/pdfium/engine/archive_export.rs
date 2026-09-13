use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use super::*;
use crate::pdfium::archive::ArchiveFormat;
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

impl PdfiumEngine {
    pub(in crate::pdfium) fn export_archive(
        &self,
        document_id: u64,
        path: &Path,
        format: ArchiveFormat,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<bool, String> {
        let operation = self.begin_operation(OperationTarget::Archive(document_id));
        let documents = self.lock_documents()?;
        let entry = open_entry(&documents, document_id)?;
        // A ZIP can never replace an open PDF, including one reached through an alias.
        if documents.values().any(|document| {
            document
                .source_path
                .as_deref()
                .is_some_and(|source| io::same_file(source, path))
        }) {
            return Err("an archive cannot replace an open PDF".into());
        }
        let source = &entry.document;
        let total = source.pages().len() as usize;
        let outline = collect_bookmark_siblings(source.bookmarks().root());
        let parts = if format == ArchiveFormat::Bookmarks {
            sections(&outline, total as i32)?
        } else {
            Vec::new()
        };
        let rasterize = entry
            .owned_content
            .as_ref()
            .and_then(|state| state.watermark.as_ref())
            .is_some_and(|config| config.rasterize);
        on_progress(0, total);
        io::write_file_atomically(path, |file| {
            let mut zip = ZipWriter::new(file);
            // Images and PDF streams are already compressed; store them without another buffer.
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(true);
            let failed = |error| format!("could not write ZIP archive: {error}");
            if format == ArchiveFormat::Bookmarks {
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
                        if !rasterize {
                            let source_page = source
                                .pages()
                                .get(page)
                                .map_err(|error| format!("could not read page links: {error}"))?;
                            links.push(collect_links(&source_page)?);
                        }
                        part.pages_mut()
                            .copy_page_from_document(source, page, page - section.start)
                            .map_err(|error| {
                                format!("could not copy page {}: {error}", page + 1)
                            })?;
                        on_progress((page + 1) as usize, total);
                    }
                    let bytes = if rasterize {
                        let Some(bytes) = self.rasterized_bytes(&part, &operation)? else {
                            return Ok(false);
                        };
                        bytes
                    } else {
                        part.save_to_bytes()
                            .map_err(|error| format!("could not save a split PDF: {error}"))?
                    };
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
                    zip.start_file(section_name(index, &section.title), options)
                        .map_err(failed)?;
                    zip.write_all(&bytes)
                        .map_err(|error| format!("could not write split PDF: {error}"))?;
                }
            } else {
                for index in 0..source.pages().len() {
                    if operation.is_cancelled() {
                        return Ok(false);
                    }
                    let page = source
                        .pages()
                        .get(index)
                        .map_err(|error| format!("could not load page {}: {error}", index + 1))?;
                    let config = PdfRenderConfig::new()
                        .scale_page_by_factor(300.0 / POINTS_PER_INCH)
                        .set_maximum_width(MAX_RENDER_WIDTH)
                        .set_maximum_height(MAX_RENDER_HEIGHT)
                        .render_annotations(true)
                        .render_form_data(true);
                    let pixels = page
                        .render_with_config(&config)
                        .and_then(|bitmap| bitmap.as_image())
                        .map_err(|error| format!("could not render page {}: {error}", index + 1))?
                        .into_rgb8();
                    let extension = if format == ArchiveFormat::Jpg {
                        "jpg"
                    } else {
                        "png"
                    };
                    zip.start_file(format!("{:04}.{extension}", index + 1), options)
                        .map_err(failed)?;
                    if format == ArchiveFormat::Jpg {
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
                    .map_err(|error| format!("could not encode page {}: {error}", index + 1))?;
                    on_progress(index as usize + 1, total);
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
