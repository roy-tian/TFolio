use super::*;

impl PdfiumEngine {
    pub(in crate::pdfium) fn render_watermark_preview(
        &self,
        document_id: u64,
        page_number: i32,
        width: i32,
    ) -> Result<Vec<u8>, String> {
        if !(MIN_RENDER_WIDTH..=MAX_THUMBNAIL_WIDTH).contains(&width) {
            return Err(format!(
                "render width must be between {MIN_RENDER_WIDTH} and {MAX_THUMBNAIL_WIDTH} pixels"
            ));
        }

        let raw = {
            let documents = self.lock_documents()?;
            let entry = open_entry(&documents, document_id)?;
            let page_id = entry.page_id(page_number)?;
            let state = entry
                .owned_content
                .as_ref()
                .filter(|state| state.watermark.is_some());
            let tail = match state {
                Some(state) => Some(state.per_page.get(&page_id).ok_or_else(|| {
                    format!("the owned-content record is missing page {page_number}")
                })?),
                None => None,
            };
            // Inserted pages have no owned segments. With a watermark present,
            // the first segment is always its ink; page numbers follow it.
            let watermark = tail.and_then(|tail| {
                tail.segments
                    .first()
                    .map(|segment| tail.base_objects..tail.base_objects + segment.object_count)
            });
            let mut copy = None;

            if watermark.is_some() {
                // Never hide objects in the live document: a failed render must
                // not change its pixels, save output, or edit history.
                let mut document = self.pdfium.create_new_pdf().map_err(|error| {
                    format!("PDFium could not create the preview document: {error}")
                })?;
                document
                    .pages_mut()
                    .copy_page_from_document(&entry.document, page_number - 1, 0)
                    .map_err(|error| format!("PDFium could not copy the preview page: {error}"))?;
                let source = state.expect("an owned watermark implies an owned-content state");
                let single_page = OwnedContentState {
                    watermark: source.watermark.clone(),
                    page_numbers: source.page_numbers.clone(),
                    per_page: HashMap::from([(page_id, tail.unwrap().clone())]),
                };
                // Check the imported objects too, rather than assuming the
                // importer preserved their order and hiding unrelated content.
                Self::verify_owned_tail(&document, &[page_id], &single_page, None, &mut |_, _| {})?;
                copy = Some(document);
            }

            let (document, index) = match &copy {
                Some(document) => (document, 0),
                None => (&entry.document, page_number - 1),
            };
            let page = document
                .pages()
                .get(index)
                .map_err(|error| format!("PDFium could not load the preview page: {error}"))?;

            if let Some(range) = watermark {
                for index in range {
                    page.objects()
                        .get(index)
                        .and_then(|mut object| object.set_inactive())
                        .map_err(|error| {
                            format!("PDFium could not hide the preview watermark: {error}")
                        })?;
                }
            }

            Self::render_page_raw(&page, width, MAX_THUMBNAIL_WIDTH)?
        };

        Self::encode_thumbnail(raw.into_rgb()?)
    }
}
