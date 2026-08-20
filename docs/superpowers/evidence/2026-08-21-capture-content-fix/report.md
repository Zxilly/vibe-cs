# Agent 成片内容修复验证

- 原问题：已导出的 8.55 秒视频使用无碰撞几何校验的静态外置机位，主体被墙体遮挡；DemoUI 控制条被录入全部采样帧。
- 修复：碰撞几何未验证时，Agent 自动方案降级为带 SteamID/第一人称模式校验的选手 POV；`demo_ui_mode 0` 等界面命令提前到 `playdemo` 之前执行。
- 工作流修复：已导出 Composition 更换 Take 时也要求显式确认，确认后可重新导出。
- 真实录制任务：`b7f87379-aa84-44b5-81e0-d82bc8be2dc8`。
- 新 Take：`77aa7f42-5eee-408a-b2fb-e4953f6f0e91`。
- 新导出任务：`ccb4dce8-8869-4e74-bc02-e2595eaec327`。
- 最终文件：`C:\Users\12009\AppData\Roaming\app.vibecs.desktop\exports\montage-a86bf42c-f363-4aef-aedd-2c8f35b43a83-ccb4dce8-8869-4e74-bc02-e2595eaec327.mp4`。
- 媒体检查：1920×1080、60 fps、H.264 + AAC 48 kHz 双声道、8.583 秒、9,239,427 bytes。
- 内容检查：全片 2 fps 抽帧无 DemoUI；5 秒后的 4 fps 抽帧持续包含近距离敌人、交火、受击与倒地画面。

## 证据

- `before-contact-sheet.jpg`：旧成片，底部 DemoUI 全程存在，外置机位主要拍到墙体。
- `final-contact-sheet.jpg`：新成片全片抽帧。
- `final-action-contact-sheet.jpg`：新成片 5 秒后高密度抽帧，验证连续交火内容。
