# Agent 成片内容修复验证

- 原问题：已导出的 8.55 秒视频使用无碰撞几何校验的静态外置机位，主体被墙体遮挡；DemoUI 控制条被录入全部采样帧。
- 修复：碰撞几何未验证时，Agent 自动方案降级为带 SteamID/第一人称模式校验的选手 POV，并把额外前后留白收紧到 0.5 秒；`demo_ui_mode 0` 等界面命令提前到 `playdemo` 之前执行。
- 时序修复：`spec_player` 在 seek 后第一个安全 tick 执行，给观察者身份留下完整预滚段稳定，不再依赖录制前 1 tick 的竞态。
- 工作流修复：已导出 Composition 更换 Take 时也要求显式确认，确认后可重新导出。
- 真实录制任务：`1762f3a6-d080-493f-bf9a-706bc845d244`。
- 新 Take：`73ae1240-1810-46c0-b891-36d17bc7c0e9`。
- 新导出任务：`d3f86bce-9d47-4fec-88d0-ec367b929777`。
- 最终文件：`C:\Users\12009\AppData\Roaming\app.vibecs.desktop\exports\montage-a86bf42c-f363-4aef-aedd-2c8f35b43a83-d3f86bce-9d47-4fec-88d0-ec367b929777.mp4`。
- 媒体检查：1920×1080、60 fps、H.264 + AAC 48 kHz 双声道、5.583 秒、6,004,600 bytes。
- 内容检查：全片 3 fps 抽帧无 DemoUI；约第 2 秒开始出现敌人，后续连续包含近距离交火、受击与倒地画面。

## 证据

- `before-contact-sheet.jpg`：旧成片，底部 DemoUI 全程存在，外置机位主要拍到墙体。
- `final-dense-contact-sheet.jpg`：最终 5.583 秒成片的全片高密度抽帧。
