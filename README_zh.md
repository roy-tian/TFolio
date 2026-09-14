# TFolio

[English](README.md) · [简体中文](README_zh.md)

TFolio 是一款轻快的开源 PDF 桌面应用。阅读、批注、合订和排版都在本机完成，文档不会上传。

## 亮点

- **快而轻**：启动迅速、浏览丝滑、安装包精简。
- **水印**：轻松添加整篇文字水印；导出时可将页面转为图片，让水印无法作为独立文字直接删除。
- **页码**：支持双面装订的奇偶页镜像、空白页计数，以及参考 [GB/T 9704—2012](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=F3CC9BEF482524C895FDA7A08BB4A70E) 的“— 1 —”样式。
- **全文搜索**：可跨视觉换行匹配短语，查询词里的回车也不会打断匹配。
- **方框效果**：拖出半透明、模糊或马赛克方框；模糊、马赛克配合图片化导出，可去掉 PDF 中的原文字层。
- **合订本**：按顺序合并 PDF、图片和 Word 文档（`.doc` / `.docx`），插入空白页，并保留或按文件生成书签；Windows 上可借助 WPS Office 转换 Word 文档。
- **MIT 开源**：基于 [MIT 许可证](LICENSE) 发布，欢迎在 [Issues](https://github.com/roy-tian/TFolio/issues) 提意见。

## 更多功能

- 单页、书本对开和缩略图视图；可拖动页面排序，或将页面拖到另一个已打开的文档。
- 高亮文字、添加文字注释；合订时还可让每个文件从奇数页开始、统一为 A4，并导出 PDF 或逐页 PNG 压缩包。

## 安装

从 [Releases](https://github.com/roy-tian/TFolio/releases) 下载 macOS（Apple Silicon / Intel）、Windows x64 或 Linux x64 安装包。

## 须知

- Word 导入依赖本机安装的 Microsoft Word、WPS Office（Windows）或 LibreOffice（macOS / Linux）；目前不支持直接导入 `.wps` 文件。
- 添加水印、页码或其他文件的页面后，只能导出副本，原文件不会被改动。可打开不超过 512 MiB 的 PDF。

版权所有 © 2026 Roy Tian
