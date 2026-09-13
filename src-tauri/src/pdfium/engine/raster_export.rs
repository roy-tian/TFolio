use super::*;

impl PdfiumEngine {
    pub(super) fn rasterized_bytes(
        &self,
        source: &PdfDocument<'_>,
        operation: &OperationGuard<'_>,
    ) -> Result<Option<Vec<u8>>, String> {
        let mut output = self
            .pdfium
            .create_new_pdf()
            .map_err(|error| format!("PDFium could not create an image PDF: {error}"))?;

        for index in 0..source.pages().len() {
            if operation.is_cancelled() {
                return Ok(None);
            }

            let page = source
                .pages()
                .get(index)
                .map_err(|error| format!("PDFium could not load page {}: {error}", index + 1))?;
            let width = page.width();
            let height = page.height();
            if !width.value.is_finite()
                || !height.value.is_finite()
                || width.value <= 0.0
                || height.value <= 0.0
            {
                return Err("a page has an unusable size for image export".into());
            }

            // 300 dpi keeps ordinary print sharp; the ceiling bounds memory for oversized sheets.
            let config = PdfRenderConfig::new()
                .scale_page_by_factor(300.0 / POINTS_PER_INCH)
                .set_maximum_width(MAX_RENDER_WIDTH)
                .set_maximum_height(MAX_RENDER_HEIGHT)
                .render_annotations(true)
                .render_form_data(true);
            let pixels = page
                .render_with_config(&config)
                .and_then(|bitmap| bitmap.as_image())
                .map_err(|error| format!("PDFium could not render page {}: {error}", index + 1))?
                .into_rgb8();
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
                .encode_image(&pixels)
                .map_err(|error| format!("could not encode page {}: {error}", index + 1))?;
            drop(pixels);

            // Inline JPEGs keep the document from retaining one uncompressed bitmap per page.
            let mut object =
                PdfPageImageObject::new_from_jpeg_reader(&output, Cursor::new(jpeg))
                    .map_err(|error| format!("PDFium could not embed a page image: {error}"))?;
            object
                .scale(width.value, height.value)
                .map_err(|error| format!("PDFium could not size a page image: {error}"))?;
            let mut target = output
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::Custom(width, height))
                .map_err(|error| format!("PDFium could not create an image page: {error}"))?;
            target
                .objects_mut()
                .add_image_object(object)
                .map_err(|error| format!("PDFium could not place a page image: {error}"))?;
            target
                .regenerate_content()
                .map_err(|error| format!("PDFium could not finish an image page: {error}"))?;
        }

        if operation.is_cancelled() {
            return Ok(None);
        }
        let bytes = output
            .save_to_bytes()
            .map_err(|error| format!("PDFium could not save the image PDF: {error}"))?;
        let outline = io::remapped_outline(collect_bookmark_siblings(source.bookmarks().root()), 0);
        let bytes = outline::write_outline(bytes, &outline)?;
        Ok((!operation.is_cancelled()).then_some(bytes))
    }
}
