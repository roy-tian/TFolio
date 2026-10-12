use super::build_pdf;

pub(crate) fn linked_chapters_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /Names << /Dests << /Names [(detail) [5 0 R /Fit]] >> >> >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [18 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [16 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [17 0 R] >>",
        "<< /Type /Outlines /First 8 0 R /Last 9 0 R /Count 2 >>",
        "<< /Title (One) /Parent 7 0 R /Next 9 0 R /Dest [4 0 R /Fit] >>",
        "<< /Title (Two) /Parent 7 0 R /Prev 8 0 R /Dest [6 0 R /Fit] >>",
        "<< /Type /Annot /Subtype /Highlight /Rect [10 250 100 270] /QuadPoints [10 270 100 270 10 250 100 250] /C [1 1 0] >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 210 100 230] /Dest [5 0 R /XYZ null 240 1.5] >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 170 100 190] /A << /S /GoTo /D [5 0 R /FitH 220] >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 130 100 150] /Dest (detail) >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 90 100 110] /A << /S /GoTo /D [6 0 R /Fit] >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 50 100 70] /A << /S /URI /URI (https://example.com) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 210 100 230] /Dest [4 0 R /FitV 25] >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 210 100 230] /Dest [6 0 R /Fit] >>",
        "<< /Type /Annot /Subtype /Link /Rect [10 210 100 230] /Dest [3 0 R /Fit] >>",
    ];
    build_pdf(
        &objects
            .iter()
            .enumerate()
            .map(|(index, object)| format!("{} 0 obj\n{object}\nendobj\n", index + 1))
            .collect::<Vec<_>>(),
    )
}
