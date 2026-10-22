# 第三方声明

这个包不带浏览器与 OCR 语言数据。下面是随包安装的依赖、运行时会去取的东西,以及各自的许可。

## 浏览器驱动

[playwright-core](https://github.com/microsoft/playwright) 1.64.0,随 npm 依赖安装,只含驱动,不含浏览器。Apache-2.0。
它驱动的是使用者电脑上已经安装的 Chrome、Edge、Brave 或 Chromium,各随其许可。

## OCR

[tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 与 tesseract.js-core 7.0.0(Tesseract OCR 编译成的 WebAssembly),随 npm 依赖安装。Apache-2.0。

## OCR 语言数据

`@tesseract.js-data/<语言>` 1.0.0 的 `4.0.0_best_int/<语言>.traineddata.gz`,第一次需要该语言时下载,解压到 `<模型根>/social/`,
按固定的 SHA-256 校验(`src/ocr.ts`)。来源按顺序尝试:jsDelivr、unpkg、npmmirror。数据来自
[tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata),Apache-2.0。

| 语言 | 文件 |
|---|---|
| 英文 | `eng.traineddata` |
| 简体中文、繁体中文 | `chi_sim.traineddata`、`chi_tra.traineddata` |
| 日文、韩文 | `jpn.traineddata`、`kor.traineddata` |
| 法文、德文、西班牙文、葡萄牙文、意大利文、俄文 | `fra`、`deu`、`spa`、`por`、`ita`、`rus` 的 `.traineddata` |
