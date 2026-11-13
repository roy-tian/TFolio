# TFolio

[English](README.md) · [简体中文](README_zh.md)

你手边的 PDF 工作伴侣：轻巧、快速、占内存少。“查看编辑”与“页面组织”两个工作区各管一摊：读、标、改一份 PDF，或把多个文件拼成一个新 PDF。文档只在本机处理，不会上传。

[官网](https://roy-tian.github.io/TFolio/) · [下载](https://github.com/roy-tian/TFolio/releases/latest)

![TFolio 的查看编辑工作区](https://roy-tian.github.io/TFolio/assets/zh/view.webp)

## 亮点

- **轻巧省内存**：Windows 安装包约 6 MB；Rust + PDFium 本机渲染，只渲染屏幕上的页面，打开即看、滚动跟手。
- **查看编辑**：高亮、文字注释，半透明、马赛克或模糊方框；插入空白页，旋转、排序、删除页面；拆分、减小文件大小、导出图片、打印。
- **页面组织**：把 PDF、图片和 Word 文档拼成新 PDF，源文件只读不改；每个文件从奇数页开始、统一为 A4，并按文件建书签。
- **智能添加空白页、水印、页码**：只在双面打印需要处补空白页；水印按页宽等比缩放；“— n —”页码按双面装订奇右偶左，落在深色区域自动变白。
- **跨行搜索**：被排版拆到两行的词、带着换行粘贴的句子，都能搜到。
- **好上手，MIT 开源**：每一步都能撤销，11 种界面语言，明暗主题可选。想法请到 [Discussions](https://github.com/roy-tian/TFolio/discussions)，问题请到 [Issues](https://github.com/roy-tian/TFolio/issues)。

## 下载

从 [Releases](https://github.com/roy-tian/TFolio/releases/latest) 下载：Windows 10 与 11 x64（`.exe` / `.msi`）、macOS Apple 芯片与 Intel（`.dmg`）、Linux x64（`.deb` / `.rpm` / `.AppImage`）。TFolio 启动时会检查更新。

## 须知

- 导入 Word 文档需本机装有 Microsoft Word、WPS Office（Windows）或 LibreOffice（macOS / Linux）；暂不支持直接导入 `.wps` 文件。
- 带水印或页码的文档只能导出副本，原文件不会被改动。可打开不超过 512 MiB 的 PDF。

版权所有 © 2026 Roy Tian
