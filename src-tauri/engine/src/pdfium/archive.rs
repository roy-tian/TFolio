use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Jpg,
    Png,
}

/// What one archive holds. The density and pages are bounded by the engine,
/// not by the dialog that picks them: a command's arguments are anyone's to send.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "format",
    rename_all_fields = "camelCase"
)]
pub enum ArchiveOptions {
    /// Every selected page as one JPG or PNG at the chosen density.
    Images {
        image_format: ImageFormat,
        dpi: u32,
        /// One-based page numbers in the document's own numbering; the engine
        /// bounds them again rather than trusting the sender's list.
        pages: Vec<u32>,
    },
    /// One PDF per top-level bookmark section.
    Bookmarks,
    /// One PDF per page.
    Pages,
}
