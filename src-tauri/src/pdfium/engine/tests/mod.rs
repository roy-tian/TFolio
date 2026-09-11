use super::*;

use allsorts::{
    binary::read::ReadScope,
    font::{Font, MatchingPresentation},
    font_data::FontData,
};

use crate::pdfium::geometry::{A4_LONG_POINTS, A4_SHORT_POINTS};
use crate::pdfium::library::PDFIUM_LIBRARY_NAME;
use crate::pdfium::page_numbers::{PageNumbersMode, PageNumbersPosition};

mod support;

mod annotations;
mod documents;
mod insert_pages;
mod merge;
mod page_numbers;
mod page_structure;
mod rect_effect;
mod save_export;
mod text_notes;
mod text_search;
mod watermark;
