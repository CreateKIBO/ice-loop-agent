# ICE Loop Studio 蓝白图标 v1

日期：2026-11-05。使用内置 imagegen 生成，并进行一次透明边缘清理；未使用外部 API Key。

设计：蓝色圆角底板搭配白色折纸回环，表达写作、审阅和持续迭代；浅冰蓝折面增强回环的层次。

资源：`ice-loop-blue-white-v1.png`，保留生成工具的原始 PNG 与透明通道。`preview.html` 提供明暗背景与多个显示尺寸的预览。

这是独立保存的设计方案，尚未替换应用内标识、Windows 可执行文件或安装包图标。发布前仍需整理透明边缘的少量残留、导出多尺寸 ICO 并在 Windows 上验收；本次不安装 Electron、不打包提版。

## 接入状态（2026-11-05，第26轮）

- **边缘清理**：`ice-loop-blue-white-v1-clean.png`（1216×1216）。以原图圆角方块（x 53–1200、y 65–1200，圆角约 186px）重建 4 倍超采样抗锯齿遮罩，方块外全部透明，去掉了外侧散落的蓝色残点；方块内的色彩和图形未改动。原始生成图 `ice-loop-blue-white-v1.png` 保留不动。
- **多尺寸导出**：`desktop/assets/icon/icon.ico`（16/24/32/48/64/128/256）与 `icon.png`（512）。16px 下回环仍可辨认。
- **已接入**：Electron 主窗口 `icon`（`main.cjs`，Windows 用 ICO）；`electron-builder.json` 的 `win.icon` 与 files 白名单 `assets/icon/**/*`（NSIS 安装器默认沿用 win.icon）；新工作台顶栏、启动 Splash、欢迎页的标识（`desktop/ui/public/brand-mark.png`，128px，经 `BrandMark` 组件加载）。
- **第27轮补全**：启动进度窗口图标（`startup-progress.cjs`）、启动等待页标识（`StartupScreen.tsx`）、经典界面侧栏标识（`renderer/index.html` + `renderer/brand-mark.png`）。
- **未做**：Windows 上任务栏/开始菜单/安装器的实际显示验收。图标蓝 `#014FE9` 与界面信号蓝 `#2448DB` 对比度均达 WCAG AA（白字 6.37 / 6.94），是否统一主色由产品决定，见第27轮记录。

## 初始提示词

```text
Use case: logo-brand.
Asset type: production-ready square desktop app icon for ICE Loop Studio, a writing and editorial creation workspace.
Primary request: redesign the app icon using blue and white.
Design: one distinctive white folded-paper loop centered on a rich blue rounded-square tile. The continuous broad ribbon makes a compact, softly angular circular loop with a clear blue opening in the middle and one restrained paper-fold detail. It should communicate iterative writing and refinement, with confident solid geometry and balanced optical weight. Make it memorable and instantly legible at 32px. Keep the silhouette simple, no thin lines and no tiny cutouts.
Style: refined minimal 2D app identity, crisp vector-like edges, smooth rounded corners, predominantly pure white symbol and saturated signal blue (#176BEB, with only a very subtle deeper-blue tonal shift in the tile). The white ribbon can use one pale icy-blue folded segment to explain the overlap. High contrast and generous breathing room.
Composition: a SINGLE icon only, front-facing, orthographic, centered, 1024x1024 square canvas; the rounded-square blue tile occupies approximately 92% of canvas width and height, with truly transparent pixels outside its rounded corners. Symbol occupies about 62% of the blue tile. No background plane or surrounding scenery.
Text: none. No lettering, no wordmark, no captions, no watermark.
Avoid: generic infinity symbol, recycling arrows, chain links, snowflakes, AI sparkles, pencil clip-art, photorealistic materials, glass, heavy 3D extrusion, ornamental details, cast shadow outside the icon, mockup presentation boards or multiple alternatives.
```

## 边缘清理提示词

```text
Refine this app icon ONLY by cleaning the outer silhouette and transparency. Preserve the blue rounded-square tile, white folded-paper loop, all interior geometry, colors, composition, and proportions exactly. Remove EVERY disconnected blue speck, stray pixel, ragged fringe, and smudge outside the smooth rounded-square boundary. Outside that single clean rounded-square silhouette, all pixels must be fully transparent. Keep smooth antialiased edges, no exterior glow or shadow. One icon, no text, no new elements.
```
