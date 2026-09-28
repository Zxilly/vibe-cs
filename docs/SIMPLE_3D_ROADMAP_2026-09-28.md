# 简易 3D 回放与镜头预演 · 路线图

2026-09-28 · 状态：实施中（2026-09-29：M0 原生物理资源解码已通过真实 Mirage 验证，网格及坐标验收进行中）

## 目标与边界

在应用内用 **用户本机 CS2 的地图碰撞网格 + demo 选手数据** 渲染一个朴素的 3D 场景，服务两件事：

1. agent 生成的 HLAE 镜头在录制前能 **自动检查遮挡与穿墙**，并由用户 **预演** 机位；
2. 回放与高光选材多一个能看清高低差和视线的 3D 视角。

不做（明确排除）：角色模型与动画、贴图光照（M6 可选除外）、枪械与第一人称武器模型、音效、体积烟的真实效果。理由见 [完整 3D 为什么不做](#完整-3d-为什么不做)。成片画质的唯一来源仍然是 CS2 + HLAE 录制。

预估：单人全职约 6–8 周（估计值，M0 验证后修正）。M3 完成时即使没有画面，agent 也能用上遮挡检查。

## 调研结论摘要

| 档位 | 难度 | 依据 |
|---|---|---|
| 2D 地图渲染 | 低，项目已完成大半 | 已有 demoparser2 解析、ARPL 回放、SVG 地图层和雷达标定；开源同类 OpenReplay [S1]、Healey 的浏览器回放 [S2] 证明路线成熟 |
| 简易 3D（真实几何 + 胶囊体） | 中 | 地图几何可从本机 VPK 取得，ValveResourceFormat（MIT）已逆向 Source 2 格式 [S4][S5]；cs2replays [S8]、kz-replay [S9]、csBoard [S10] 已在浏览器内做出 3D 回放 |
| 完整 3D（接近游戏画面） | 极高 | 角色动作由客户端 AnimGraph 2 计算 [S13][S14]，demo 中没有骨骼姿态；还需重做材质、光照、烟雾、粒子，最终仍要回 CS2 录制 |

### 现有代码基础

| 能力 | 位置 |
|---|---|
| demo 解析（vendored demoparser2） | `vendor/demoparser`（来源见 `vendor/demoparser/UPSTREAM.md`），封装于 `crates/demo` |
| entity 回放字段（位置、`m_angEyeAngles`、血量、护甲、武器、按键） | `crates/demo/src/entity_replay.rs`，默认每 64 tick 取一帧 |
| 分回合回放（16 tick，最多 2048 帧，未开启 `parse_grenades`） | `crates/demo/src/round_replay.rs` |
| ARPL 写入 / 读取 | `crates/application/src/routes/demos.rs`（写）、`apps/web/src/data/replayBinary.ts`（读） |
| 2D 渲染（SVG） | `apps/web/src/domain/map/MapCanvas.tsx`、`ReplayCanvas.tsx`，标定 `mapCalibration.ts` |
| VPK / VTEX 读取、CS2 安装探测、雷达图 | `crates/source-assets/src/{vpk,vtex,cs2}.rs`，路由 `crates/application/src/routes/source_assets.rs` |
| HLAE campath 编译（位置 Cubic、旋转 SphericalCubic、FOV cubic） | `crates/hlae/src/compile.rs`（`compile_camera_path`） |
| 镜头风格与关键帧生成 | `crates/domain/src/recording.rs`（`HlaeCameraStyle`、`DirectorShot`）、`crates/runtime/src/camera_planning.rs` |
| agent 镜头校验 | `apps/desktop/src-tauri/src/agent.rs` |
| 现有镜头预览（2D 虚线示意） | `apps/web/src/domain/map/CameraPathLayer.tsx` |

现有数据缺口：ARPL 只存 yaw，没有 pitch；采样粗（1 秒一帧）；道具只有爆点事件，没有飞行轨迹；格式用 f64 且每帧重复名字字符串（约 1 KB/帧），读取端上限为 20 万条选手记录；没有任何地图几何。

## 架构

```
CS2 安装目录
  └ maps/<map>.vpk ──► source-assets: world_physics.vmdl_c / PHYS → KV3 解码 → 过滤挡视线三角形
                                     └► 自有网格格式（按地图缓存于 app data）
demo ──► crates/demo ──► ARPL v2（pitch、密采样、道具轨迹）
                   │
runtime: campath 采样为逐帧机位 ◄── camera_planning（agent 生成的镜头）
         遮挡检测（parry3d BVH）──► 镜头诊断 ──► agent / 用户
                   │
web: domain/scene3d（three.js，渲染循环与 React 解耦）
     ├ 回放页 3D 视图（自由 / 跟随选手 / 机位视角）
     └ 剪辑页：未录制片段在 Program Monitor 显示 3D 预演
```

原则（与 `AGENTS.md` 对齐）：

- **插值只实现一次**：mirv campath 的 Cubic / SphericalCubic 插值 [S12] 只在 Rust 实现，遮挡检测与前端预演消费同一批采样结果，前端不自行插值。
- **不并存两套实现**：ARPL v2 直接替换 v1；3D 镜头预演就位后删除 `CameraPathLayer`。
- **无几何时同一条路径**：未安装 CS2 或导出失败时，3D 视图只画选手和机位，不回退到 2D 预览。
- **不分发游戏资源**：只在用户本机读取并缓存，与 AnotherCSDemoViewer 的做法一致 [S11]。

---

## M0 · 技术验证（2–3 天）

决定几何获取方案，输出验证记录。

- [x] 从本机 `game/csgo/maps/de_mirage.vpk` 中用 `crates/source-assets/src/vpk.rs` 列出并读取物理资源；实际路径为 `maps/de_mirage/world_physics.vmdl_c`，原计划的 `.vphys_c` 不存在
- [x] 评估并实现 Rust 原生二进制 KV3 v5 解码（资源块结构、未压缩/LZ4/Zstd）；参考 ValveResourceFormat [S3]，保留 MIT 声明。真实 Mirage 使用 v5 + Zstd，其他版本明确拒绝。`kv3` 0.2.1 与 `keyvalues3` 1.1.0 均面向文本，不能复用为二进制解码器
- [ ] 备选方案：Source2Viewer-CLI 旁挂 [S6]。确认其能否导出物理网格（官方 CLI 文档未写明 vphys 导出 [S6]；地图导出文档说明 glTF 含几何、贴图和 prop，不含光照与导航网格 [S4]），并测量 .NET 运行时带来的包体增量
- [ ] 坐标对齐：随机抽取 demo 中选手落地时刻，脚底 Z 与网格地面误差 < 2 单位
- [ ] 过滤规则：区分天空盒、玩家专用空气墙、挡子弹/挡视线的碰撞属性，只保留挡视线几何
- [ ] 体积与耗时：过滤后网格 < 10 MB，首次导出 < 10 s
- [ ] 结论写入本文件「决策记录」一节（倾向 Rust 原生：无外部运行时、单一实现路径）

## M1 · 回放数据 ARPL v2（约 1 周）

- [ ] `crates/demo`：entity 回放补 pitch（`m_angEyeAngles` 已读取，仅未输出）
- [ ] 采样：默认 16 tick 一帧，高光片段内 8 tick
- [ ] 开启 `parse_grenades`，输出投掷物飞行轨迹、烟雾与燃烧范围及起止 tick
- [ ] 格式压缩：选手表（id、名字、队伍）只存一次、每帧存索引；坐标 f32 或量化；字符串去重
- [ ] 同步改写 `crates/application/src/routes/demos.rs`（写）与 `apps/web/src/data/replayBinary.ts`（读），按新数据量重设读取上限
- [ ] 同步改写 `apps/web/src/dev/mockReplay.ts`
- [ ] 删除 v1 读写代码与测试，不做兼容读取
- [ ] 2D 回放与高光预览加插值：位置线性插值，角度走最短路径 [S2]
- [ ] 2D 画出道具飞行轨迹
- [ ] 验收：整场 replay.bin 小于现在；2D 回放肉眼流畅；`pnpm test`、`cargo test` 全绿

## M2 · 地图几何管线（1–1.5 周）

- [ ] `crates/source-assets/src/map_geometry.rs`：定位地图 VPK → 解析 vphys → 过滤 → 输出自有紧凑网格格式（量化顶点 + 索引，风格同 ARPL）
- [ ] 缓存：app data 下按「地图名 + VPK 大小与修改时间」为键，游戏更新自动失效重建
- [ ] 路由 `GET /api/source-assets/map-geometry/:map`，与现有 `/source-assets/radar` 同风格；runtime 接线放在 `crates/runtime/src/source_assets.rs`
- [ ] 设置页游戏区域（`apps/web/src/pages/shared/settings/GameSection.tsx`）显示每张图的几何状态与重建入口
- [ ] `mockBackend` 生成带墙和箱子的合成地图，浏览器开发与走查不依赖 CS2
- [ ] 测试：KV3 解码与网格编码用合成数据做单元测试；读真实安装的集成测试用环境变量开关，CI 默认跳过
- [ ] 格式识别失败时返回明确错误，不崩溃

## M3 · 遮挡检测与机位校验（约 1 周）

不需要画面即可交付价值。

- [ ] 在 `crates/hlae` 实现 campath 插值（位置 Cubic、旋转 SphericalCubic、FOV cubic），与 `compile.rs` 写出的 XML 语义一致 [S12]
- [ ] 按 30 fps 将每个镜头采样为逐帧机位（位置、朝向、FOV）
- [ ] runtime 引入 `parry3d` [S16]，对地图网格建 BVH
- [ ] 每帧检查：
  - [ ] 相机 → 目标选手头部/胸部的视线是否被遮挡
  - [ ] 相机是否在墙内或贴墙（到几何距离 < 16 单位）
  - [ ] 目标是否在视锥内
- [ ] `crates/runtime/src/camera_planning.rs` 生成关键帧后自检，失败时换镜头风格或调整参数
- [ ] `apps/desktop/src-tauri/src/agent.rs` 的镜头校验返回结构化诊断（例如「3.2–4.1 s 目标被遮挡 72%」），供 agent 修正
- [ ] 片段属性中显示镜头问题（穿墙、遮挡），仅提示，不硬性拦截录制
- [ ] 验收：真实高光上的 Flyby / Crane 镜头能检出穿模并自动修正
- [ ] 验收：同一 campath 用 `mirv_campath draw` 实拍，与采样结果比对，确认插值一致

## M4 · 3D 视图模块（1.5–2 周）

- [ ] 新建 `apps/web/src/domain/scene3d`；three.js [S17] 动态导入，不进入首屏包
- [ ] 渲染循环用 requestAnimationFrame，与 React 渲染解耦（OpenReplay 的 Canvas 做法 [S1]）
- [ ] 场景内容：
  - [ ] 网格平涂 + 法线明暗
  - [ ] 选手胶囊体：队伍色、朝向、视线
  - [ ] 道具轨迹；烟雾用半透明球体，燃烧用地面贴片
- [ ] 颜色（含 team/a、team/b）运行时读取 `theme.css` 的 CSS 变量，不写页面私有样式
- [ ] 视角：自由轨道、跟随选手、机位视角
- [ ] 回放页（`ReplayView`）在 2D 地图旁加 3D 视图，共用播放时钟、选中选手与时间轴
- [ ] 性能：WebView2 上稳定 60 fps，内存 < 300 MB
- [ ] 测试：机位与姿态数学用 vitest；用 mock 合成地图配合 agent-browser 截图核对

## M5 · 镜头预演接入剪辑（1–1.5 周）

- [ ] 片段属性与录制确认弹窗显示 3D 机位预演（使用 M3 的采样结果），画出视锥、机位轨迹，并高亮遮挡区间
- [ ] 删除 `apps/web/src/domain/map/CameraPathLayer.tsx` 及其测试和导出
- [ ] 未录制片段在 Program Monitor 显示 3D 预演，遵守 `AGENTS.md` 的 Program Monitor 约束：
  - [ ] 画面只受 Timeline Transport 驱动
  - [ ] 按片段维护稳定的预演池
  - [ ] 连续跳转只处理最新目标
  - [ ] 新画面就绪前保留上一帧
- [ ] 画面角标写「预演」，与已录制素材区分
- [ ] `apps/web/DESIGN.md` 增加 3D 预演规则；Figma 同步对应画板
- [ ] 补 zh-CN / en-US 文案

## M6 · 打磨（按需）

- [ ] 贴图版可视网格（vmdl / vmat 导出，贴图降采样，< 50 MB），作为可选高质量模式；参考 kz-replay 的烘焙光照做法 [S9] 与 cs2replays 的体积数据（Dust II 88 MB）[S8]
- [ ] 支持现役地图池以外的地图与创意工坊地图
- [ ] 网格分区块可见性剔除，降低内存

---

## 风险

| 风险 | 应对 |
|---|---|
| 二进制 KV3 / vphys 格式随游戏更新变化（Valve 未公开格式，依赖逆向 [S9][S3]） | M0 先验证；识别失败时返回明确错误，3D 退为无地图模式 |
| 物理网格与实际视线有差别（植被、半透明物体） | 只用过滤出的挡视线几何；诊断只提示，不拦截录制 |
| mirv 插值复现不精确 | M3 验收项：与 `mirv_campath draw` 实拍对比 |
| three.js 增大包体 | 仅在 3D 视图中动态导入 |
| 范围蔓延到完整 3D | 本文件「不做」清单为准，变更需先改本文件 |

## 完整 3D 为什么不做

- CS2 的角色动作由客户端的 AnimGraph 2 计算；Valve 在 AnimGraph 2 中重点压缩了动画数据的网络传输 [S13][S14]，demo 中没有可直接使用的骨骼姿态。复刻需要重写动画图，或用移动混合近似，效果必然走样。
- 材质着色器、体积烟、粒子、武器模型、光照都要重做；ValveResourceFormat 的渲染器（OpenGL / C#）已包含其中一部分 [S5][S7]，但它不是可嵌入 WebView 的 Web 渲染器。
- 即使做到接近游戏，成片仍要回 CS2 用 HLAE 录制。
- 市面上宣称 3D 的产品（Memorin [S18]）也只做到 tick 级精度，不重建 sub-tick 顺序。

## 决策记录

- [x] M0：几何获取方案——Rust 原生；已解码本机 Mirage 的 PHYS 数据，不引入 .NET 旁挂。CLI 导出能力/包体对照仍待记录，不能视为该验收项完成
- [ ] M0：网格过滤规则——待定
- [ ] M1：默认采样间隔——暂定 16 tick，高光内 8 tick

### 2026-09-29 · M0 首轮实测

- 本机 `de_mirage.vpk` 为 176,187,297 bytes，修改时间 2026-09-23 08:27；699 个条目。原 VPK 读取器要求 `_dir.vpk` 后缀，现已支持独立 `.vpk` 地图包，并保留路径、范围、CRC 校验。
- `maps/de_mirage/world_physics.vmdl_c` 为 3,494,920 bytes；资源头版本 12，PHYS 使用 KV3 v5 / Zstd。原生完整解码一次约 136 ms（debug、本机缓存条件，包含 VPK 打开/读取/CRC 与诊断输出）；**不是**完整网格首次导出的耗时。
- 解析到 1 个 physics part、9 组 collision attributes、40 个 surface hashes。属性包括默认实体、`passbullets`、`npcclip/playerclip`、`ladder`、`csgo_grenadeclip`、`window`、`sky`。尚未将这些标签等同于视觉遮挡规则；玻璃、可穿透表面和实体状态需要进一步验证。
- 上游参考固定于 ValveResourceFormat `b20af3819872f010da71c74c47e79191bb070c97` 的 `BinaryKV3.cs`；MIT 声明保存在 `crates/source-assets/licenses/ValveResourceFormat-MIT.txt`。不随代码提交游戏资源。
- 单元测试：30 passed；真实安装测试显式运行：2 passed（Mirage PHYS、Dust II 雷达）。覆盖三种压缩、所有截断前缀、异常版本、分配上限、损坏 trailer 和资源目录重叠；严格 Clippy 通过。
- 真实 demo 已定位：本机应用数据目录的 `demos/iem-cologne-major-2026-final/furia-vs-falcons-m1-mirage.dem`。接下来提取/过滤三角形，并用该 demo 验证地面坐标；尚未声称脚底 Z 误差或网格体积达标。

复现（PowerShell）：

```powershell
$env:VIBE_CS2_INSTALL = 'E:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive'
cargo run -p vibe-cs-source-assets --example physics_probe -- "$env:VIBE_CS2_INSTALL/game/csgo/maps/de_mirage.vpk"
cargo test --locked -p vibe-cs-source-assets
cargo test --locked -p vibe-cs-source-assets -- --ignored --nocapture
cargo clippy --locked -p vibe-cs-source-assets --all-targets -- -D warnings
```

## 参考来源

外部资料（检索于 2026-09-28）：

- [S1] OpenReplay：开源 CS2 2D 回放，Rust WASM 解析 + Canvas 2D，MIT — https://github.com/c0mpl9x/openreplay
- [S2] Andrew Healey, *Rendering Counter-Strike Demos in the Browser*：demoinfocs-golang 解析、SVG 渲染、位置与角度插值 — https://healeycodes.com/rendering-counter-strike-demos-in-the-browser
- [S3] ValveResourceFormat（Source 2 Viewer）源码：VPK、KV3、模型、地图解析与导出 — https://github.com/ValveResourceFormat/ValveResourceFormat
- [S4] Source 2 Viewer · Exporting Maps：地图导出为 glTF，含几何、贴图、prop，不含光照与导航网格 — https://s2v.app/ValveResourceFormat/guides/exporting-maps.html
- [S5] Source 2 Viewer 主页 / 概述 — https://s2v.app/ValveResourceFormat/
- [S6] Source 2 Viewer · Command-line utility：`-i`、`-f`、`-o`、`--gltf_export_format` 等参数 — https://s2v.app/ValveResourceFormat/guides/command-line.html
- [S7] ValveResourceFormat.Renderer（NuGet，OpenGL 渲染器） — https://libraries.io/nuget/ValveResourceFormat.Renderer
- [S8] CS2 Replays · 3D Viewer Beta：Blender 手工精简地图、GLB 88 MB、每次更新需重导 — https://cs2replays.com/guides/3d-viewer/
- [S9] kz-replay：three.js 回放，地图几何与烘焙光照来自 Source 2 Viewer，AGPL-3.0 — https://github.com/y-meechy/kz-replay
- [S10] csBoard：three.js + GLB 地图的 3D 战术板与 demo 回放 — https://github.com/dlwm/csBoard
- [S11] AnotherCSDemoViewer：用 Source2Viewer-CLI 从本机游戏文件提取资源、不分发游戏文件 — https://github.com/jmc1805/AnotherCSDemoViewer
- [S12] HLAE（mirv_campath 所属项目） — https://github.com/advancedfx/advancedfx
- [S13] Counter-Strike 官方 · Animgraph 2 Beta — https://www.counter-strike.net/newsentry/528750051218948816
- [S14] HLTV · AnimGraph2 goes live in latest CS2 update — https://www.hltv.org/news/44430/animgraph2-goes-live-in-latest-cs2-update
- [S15] kv3 crate（Rust KV3 解析，serde 支持） — https://github.com/dxshie/kv3
- [S16] parry3d（Rust 碰撞检测与射线查询） — https://parry.rs/
- [S17] three.js — https://threejs.org/
- [S18] Memorin：浏览器 3D demo 回放，tick 级精度 — https://memorin.app/
- [S19] demoinfocs-golang — https://github.com/markus-wa/demoinfocs-golang
- [S20] 其他 2D 在线回放参考：scope.gg — https://scope.gg/replay/ ；cs2replays — https://cs2replays.com/

仓库内依据：见「现有代码基础」表；另见 `AGENTS.md`（单一实现路径、Program Monitor 与时间线约束）、`apps/web/DESIGN.md`。
