# 简易 3D 回放与镜头预演 · 路线图

2026-09-28 · 状态：实施中（2026-09-29：M1 密集回放和 M2 地图几何管线完成，M0 坐标残差及 M3–M5 继续实施）

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
| 共享镜头预演 | `apps/web/src/domain/scene3d/CameraPreviewViewport.tsx` |

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
- [x] 备选方案：Source2Viewer-CLI 20.0 已从本机 Mirage 导出物理 GLB；同版本源码分别发布 framework-dependent / self-contained，运行时增量约 80.2 MB，详见决策记录
- [ ] 坐标对齐：随机抽取 demo 中选手落地时刻，脚底 Z 与网格地面误差 < 2 单位
- [ ] 过滤规则：区分天空盒、玩家专用空气墙、挡子弹/挡视线的碰撞属性，只保留挡视线几何
- [x] 体积与耗时：8 张真实地图 VMAP 全部 < 10 MB，release 下不命中应用缓存的导出 69–892 ms（OS 文件缓存可能已热，详见实测记录）
- [ ] 结论写入本文件「决策记录」一节（倾向 Rust 原生：无外部运行时、单一实现路径）

## M1 · 回放数据 ARPL v2（约 1 周）

- [x] `crates/demo`：entity 回放补 pitch（`m_angEyeAngles` 已读取，仅未输出）
- [x] 采样：默认 16 tick 一帧，高光片段内 8 tick
- [x] 开启 `parse_grenades`，输出投掷物飞行轨迹、烟雾与燃烧范围及起止 tick
- [x] 格式压缩：选手表（id、名字、队伍）只存一次、每帧存索引；坐标 f32 或量化；字符串去重
- [x] 同步改写 `crates/application/src/routes/demos.rs`（写）与 `apps/web/src/data/replayBinary.ts`（读），按新数据量重设读取上限
- [x] 同步改写 `apps/web/src/dev/mockReplay.ts`
- [x] 删除 v1 读写代码与测试，不做兼容读取
- [x] 2D 回放与高光预览加插值：位置线性插值，角度走最短路径 [S2]
- [x] 2D 画出道具飞行轨迹
- [x] 验收：整场 replay.bin 小于现在；2D 回放肉眼流畅；`pnpm test`、`cargo test` 全绿

## M2 · 地图几何管线（1–1.5 周）

- [x] `crates/source-assets/src/map_geometry.rs`：定位地图 VPK → 解析 PHYS → 过滤 → 输出自有紧凑网格格式（量化顶点 + 索引，风格同 ARPL）
- [x] 缓存：app data 下按「地图名 + VPK 大小与修改时间」为键，游戏更新后下次请求自动失效重建；另包含安装路径与提取版本
- [x] 路由 `GET /api/source-assets/map-geometry/:map`，另有状态查询与显式重建；runtime 接线放在 `crates/runtime/src/source_assets.rs`
- [x] 设置页游戏区域（`apps/web/src/pages/shared/settings/GameSection.tsx`）显示 8 张支持地图的几何状态与重建入口
- [x] `mockBackend` 使用原生生产提取器生成的墙/箱子合成 VMAP，浏览器开发与走查不依赖 CS2
- [x] 测试：KV3 解码与网格编码用合成数据做单元测试；读真实安装的集成测试用环境变量开关，CI 默认跳过
- [x] 格式识别失败时返回明确错误，不崩溃；缓存损坏自动重建，设置页保留可重试错误

## M3 · 遮挡检测与机位校验（约 1 周）

不需要画面即可交付价值。

- [x] 在 `crates/hlae` 实现 campath 插值（位置 Cubic、旋转 SphericalCubic、FOV cubic），与 `compile.rs` 写出的 XML 语义一致 [S12]
- [x] 按 30 fps 将每个镜头采样为逐帧机位（位置、朝向、FOV）
- [x] runtime 引入 `parry3d` [S16]，对地图网格建 BVH
- [ ] 每帧检查：
  - [x] 相机 → 目标选手头部/胸部的视线是否被遮挡
  - [ ] 相机是否在墙内或贴墙（到几何距离 < 16 单位）
  - [x] 目标是否在视锥内
- [x] `crates/runtime/src/camera_planning.rs` 生成关键帧后自检，失败时换镜头风格或调整参数
- [x] `apps/desktop/src-tauri/src/agent.rs` 的镜头校验返回结构化诊断（例如「3.2–4.1 s 目标被遮挡 72%」），供 agent 修正
- [x] 片段属性中显示镜头问题（穿墙、遮挡），仅提示，不硬性拦截录制
- [x] 验收：真实高光上的 Flyby / Crane 镜头能检出穿模并自动修正（真实静态几何与生产回合数据通过，游戏实拍见下一项）
- [ ] 验收：同一 campath 用 `mirv_campath draw` 实拍，与采样结果比对，确认插值一致

## M4 · 3D 视图模块（1.5–2 周）

- [x] 新建 `apps/web/src/domain/scene3d`；three.js [S17] 动态导入，不进入首屏包
- [x] 渲染循环用 requestAnimationFrame，与 React 渲染解耦（OpenReplay 的 Canvas 做法 [S1]）
- [x] 场景内容：
  - [x] 网格平涂 + 法线明暗
  - [x] 选手胶囊体：队伍色、朝向、视线
  - [x] 道具轨迹；烟雾用半透明球体，燃烧用地面贴片
- [x] 颜色（含 team/a、team/b）运行时读取 `theme.css` 的 CSS 变量，不写页面私有样式
- [x] 视角：自由轨道、跟随选手、机位视角
- [x] 回放页（`ReplayView`）在 2D 地图旁加 3D 视图，共用播放时钟、选中选手与时间轴
- [ ] 性能：WebView2 上稳定 60 fps，内存 < 300 MB
- [x] 测试：机位与姿态数学用 vitest；用 mock 合成地图配合 agent-browser 截图核对

## M5 · 镜头预演接入剪辑（1–1.5 周）

- [x] 片段属性与录制确认弹窗显示 3D 机位预演（使用 M3 的采样结果），画出视锥、机位轨迹，并高亮遮挡区间
- [x] 删除 `apps/web/src/domain/map/CameraPathLayer.tsx` 及其测试和导出
- [x] 未录制片段在 Program Monitor 显示 3D 预演，遵守 `AGENTS.md` 的 Program Monitor 约束：
  - [x] 画面只受 Timeline Transport 驱动
  - [x] 按片段维护稳定的预演池
  - [x] 连续跳转只处理最新目标
  - [x] 新画面就绪前保留上一帧
- [x] 画面角标写「预演」，与已录制素材区分
- [x] `apps/web/DESIGN.md` 增加 3D 预演规则；Figma 同步对应画板
- [x] 补 zh-CN / en-US 文案

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
- [x] M1：默认采样间隔——16 tick，高光内 8 tick；缺失网络 tick 对齐到实际 packet，详见 ARPL v2 格式

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

### 2026-09-29 · 静态三角形提取进展

`map_geometry.rs` 已实现 PHYS 的静态 mesh 读取、convex hull 面扇形三角化、1/16 单位量化与顶点焊接；索引越界、非有限坐标和损坏半边环均报错。当前保留默认实体，排除已识别的玩家/NPC/投掷物工具碰撞、梯子、天空和窗口属性；这是物理几何的可见性近似，还不能替代游戏实拍的遮挡验收。

| 真实地图 | 顶点 | 三角形 | 保留 / 排除形状 | 顶点+索引原始大小 | debug 探针总时间 |
|---|---:|---:|---:|---:|---:|
| Mirage | 73,649 | 122,643 | 1,859 / 82 | 2,355,504 bytes | 322 ms |
| Dust II | 231,957 | 419,440 | 10,105 / 44 | 7,816,764 bytes | 1,397 ms |

探针时间包含完整提取及额外一次 KV3 诊断解码，受本机缓存影响，尚未计入最终缓存格式写盘。M0 的「首次导出 < 10 s」暂不勾选。当前 source-assets 单测 33 passed，真实 Mirage 网格测试另行通过；原有两项真实资源测试已在上一阶段通过。

扩展实测暴露的待办（均明确返回错误，没有静默省略几何）：Inferno 的 PHYS 解压计数超出当前 128 MiB 上限；Nuke、Ancient、Train 有 `blocklight`；Anubis 有 `navclip`；Overpass 含 sphere。M2 接入产品前需要验证对应规则、支持这些形状，并评估大地图内存与体积；不能把 Mirage 的结果推广为全地图支持。

远端验收另发现两项原主分支问题：中文字体导出测试依赖 CI runner 缺少的 `C:/Windows/Fonts/simhei.ttf`；依赖审计报 `RUSTSEC-2026-0285`。后者已将 rustls 0.23.43 更新为 0.23.45，`vibe-cs-integrations` 32 项测试通过；字体测试待改为可复现的开源字体 fixture。完整远端 CI 尚未通过。

### 2026-09-29 · 全图形状、CLI 对照与落地检验

- 已支持 sphere/capsule 三角化（径向弦误差目标 0.25 单位、最大 256 段，随后 1/16 单位量化），补闭合性、朝外绕序、径向误差和非法半径测试。
- 实测 Inferno PHYS 二进制块为 141,610,742 bytes，因此将总解压上限提高到 256 MiB，值节点上限 400 万，三角形上限 400 万；仍先验证大小再解压，非无限分配。8 张真实地图的提取集成测试通过。
- 碰撞规则的本机依据：`csgo/pak01_dir.vpk` 中 `scripts/collision_properties.txt` 明确区分 window、不挡 LOS 的 solid、声音专用碰撞、玩家/投掷物碰撞；`core/pak01_dir.vpk` 的 `toolsblocklight.vmat_c` 和 `toolsnavclip.vmat_c` 标记工具材质。Nuke 存在 `blocklight, blocklos, blocksound, solid` 组合，必须保留显式 solid/LOS，不能因同时含工具标签而全部排除。声音、光照、导航专用形状不作为遮挡体，未知标签明确报错。

| 地图 | 顶点 | 三角形 | 顶点+索引原始大小 |
|---|---:|---:|---:|
| Inferno | 1,369,614 | 2,527,380 | 46,763,928 bytes |
| Nuke | 85,848 | 163,593 | 2,993,292 bytes |
| Ancient | 496,625 | 958,470 | 17,461,140 bytes |
| Anubis | 375,182 | 672,703 | 12,574,620 bytes |
| Train | 797,091 | 1,532,622 | 27,956,556 bytes |
| Overpass | 406,700 | 711,210 | 13,414,920 bytes |

因此紧凑编码是必需项，不能把 Mirage 的原始体积达标等同于全地图达标。

CLI 对照：官方 20.0 `cli-windows-x64.zip` 为 52,735,867 bytes，解包三个文件共 127,601,184 bytes。参数 `-i de_mirage.vpk -f maps/de_mirage/world_physics.vmdl_c -d --gltf_export_format glb -o ...` 成功生成 14,425,104-byte 的 `_physics.glb`（另有 236-byte 空可视模型）。同一参考源码、win-x64、Release、关闭 single-file 和 ReadyToRun，framework-dependent 发布为 110,564,322 bytes，self-contained 为 190,720,169 bytes，差值 **80,155,847 bytes**。原生 Rust 方案继续采用；CLI 仅用于开发验证。

落地检验尚未通过，不调整坐标去掩盖误差：

- 用独立 `demoparser2==0.42.0` 读取真实决赛 demo，SHA-256 `04f26f0f092f24fd13e7939dc56e72a3783a61872500b97b09810ed5a2363697`。
- `scripts/sample-demo-landings.py` 固定 seed 20260929，先随机取 32 个连续 256-tick 窗口，再从 75 个 alive 且 FL_ONGROUND 由 0→1 的相邻 tick 状态中随机取 32 个；选择过程不读取地图几何。
- 中心向下射线有 15 个样本超过 2 单位；考虑 +/-16 单位玩家水平碰撞盒、将三角形裁剪到脚底区域后，只剩 3 个，最大误差 7.328125。复现入口为 `cargo run -p vibe-cs-source-assets --example geometry_alignment -- MAP.vpk LANDINGS.json`，未达标会返回非零退出码。
- 逐 tick 追踪三个残差，发现 FL_ONGROUND 首次置位后位置仍继续下降；还需核对网络位置时序、玩家专用支撑几何、PHYS 碰撞皮肤与历史 demo/当前地图差异。坐标对齐验收继续保持未完成。

完整 CI 的字体依赖已改为仓库内 3,208-byte 开源中文字体子集（许可证与可复现脚本齐备），两项原生导出测试通过；rustls 更新后的远端依赖审计也已通过。

### 2026-09-29 · VMAP 紧凑格式与真实写盘验收

新增 [VMAP 格式](MAP_GEOMETRY_FORMAT.md)：1/16 单位量化、坐标/索引差分、zigzag varint、zlib 压缩，包含尺寸、版本和 CRC32 校验。解码限制顶点 200 万、三角形 400 万、膨胀载荷 128 MiB，拒绝截断 zlib 流、尾随数据、非规范 varint 和越界索引。没有使用几何简化来达到体积目标。

`geometry_export` 使用 release 构建，从本机 VPK 读取 → 解码 → 过滤/三角化/焊接 → 编码 → 写入新 VMAP 文件，随后重新读取并逐项比对，8 张图全部 exact round trip：

| 地图 | VMAP 文件字节 | 导出到写盘耗时 |
|---|---:|---:|
| Mirage | 451,551 | 69 ms |
| Dust II | 1,450,345 | 285 ms |
| Inferno | 8,660,835 | 892 ms |
| Nuke | 464,016 | 113 ms |
| Ancient | 3,607,884 | 282 ms |
| Anubis | 1,915,071 | 393 ms |
| Train | 4,737,268 | 542 ms |
| Overpass | 2,605,302 | 242 ms |

这些时间不含编译，不是系统冷启动磁盘基准；没有复用应用网格缓存。真实文件留在本机被 Git 忽略的 `artifacts/simple-3d/`，不提交游戏资源。source-assets 单测现为 37 passed，严格 Clippy 通过。M2 的应用缓存、HTTP 路由、浏览器解码和设置状态仍待接入。

### 2026-09-29 · M2 产品接线与验收

- 已接入 `Cs2AssetStore` 地图路径校验、持久 VMAP 缓存、应用调度器三个接口和设置页；新增 `missing/stale/building/ready/failed/unavailable` 状态，重建请求成功后才显示已准备。
- 缓存沿用回放缓存的目录能力与原子写入实现，抽出两者共用的 `cache_directory`，避免另写一套文件安全逻辑。测试覆盖缓存复用、包大小/mtime 变化、损坏恢复、提取期间源变化和指向外部目录的 Windows junction；外部哨兵文件保持原样。
- 环境变量开启的真实测试走应用 dispatcher，从本机 Mirage 返回 73,649 个顶点、122,643 个三角形、451,099-byte VMAP，随后验证缓存命中、状态和 POST 重建。压缩后字节数可因依赖特性选择的 DEFLATE 后端不同而略有差异，解码结果与校验契约一致。
- Chrome 使用生产 `decodeMapGeometry` 解码真实 API 返回文件（22 ms）和 Inferno 文件（330 ms），顶点/索引数量与 Rust 一致。这不是 M4 的 WebView2 帧率验收。
- 浏览器走查：设置页 1440×900、900×700，浅色与系统深色主题；键盘 Enter 生成 Nuke 的开发地图后，行状态由尚未生成变为已准备。新增区域 axe 检查 0 violations，Impeccable detector 0 findings。页面走查使用明确的合成 fixture，真实地图数据验证另走上述 API/解码链。
- 本地 `cargo test --workspace --locked` 通过；新增缓存状态修正另跑相关测试与严格 Clippy 通过。`pnpm test` 306 个文件、3,291 项通过，1 项真实地图测试默认跳过（已显式开启另跑通过）；`pnpm lint`、`pnpm build` 通过，中英翻译无缺项，`pnpm bindings` 已重生成。
- 全量 CI 发现第二处 SimHei 依赖（runtime 字体元数据测试），已同样改用仓库内开源字体 fixture；本地整仓 Rust 测试通过，新的远端检查仍需等待。

M2 完成不代表整个功能完成：M0 的三个落地残差仍待解释，M1 的密集回放数据、M3 遮挡与 campath、M4 3D 视图、M5 剪辑预演尚未完成。

### 2026-09-29 · M1 密集回放与浏览器验收

- ARPL v2 已直接替换 v1，格式见 [REPLAY_FORMAT.md](REPLAY_FORMAT.md)。选手身份/字符串表去重、1/16 单位坐标差分、yaw/pitch 定点数和 zlib 压缩；原有事件位置拼接选手回放路径已删除。整场与单回合共用实体快照读取，单回合录制输入也保留 pitch、道具和炸弹状态。
- 默认 16 tick，高光 8 tick，并加入事件时刻。真实 Demo 的 tick 62029 没有 packet（62028 后直接是 62030）；新增有上限的原始 packet 索引，对齐最近真实 tick，不伪造状态。帧、选手、道具、字符串及压缩数据分别有边界检查。
- 同一 Mirage 决赛 Demo 提取到 **18,266 帧、182,660 条选手记录、7,338 条飞行道具记录、26,071 条效果记录**；177,712 条选手记录有非零 pitch。debug 生产提取探针约 28.8 秒。范围圆明确标记为示意，不声称重建体积烟或精确燃烧面。
- 原生编码文件 **1,078,552 bytes**，此前 v1 稀疏数据 **1,841,021 bytes**（2,479 帧、21,447 条选手记录）：选手记录增加约 8.5 倍，文件减少约 **41.4%**。DEFLATE 后端可能造成个位数字节差异。
- 隔离 runtime 验收使用当前生产 worker、内存数据库及临时目录：首次生成约 58.2 秒，缓存命中约 3.1 秒；78,761,779-byte 缓存逐帧一致，worker 任务目录清空。未修改现有用户数据库。真实第 20 回合另外验证 319 个单回合采样、每帧 10 人、pitch 和道具；零行预算下投掷物解析正确报资源限制。
- Chrome 从本机原生 ARPL 文件解码约 142 ms。通过本次走查专用浏览器 IPC 覆盖加载真实回放/分析数据；回放 1440×900、1000×700 和高光预览可见选手朝向、道具尾迹与范围示意。3 秒播放测得 84 次位置更新；暂停、速率与整数 tick 地址沿用原接口。底图仍是浏览器模式的相对坐标网格，本次不将其当作雷达/地面坐标验收。
- `cargo test --workspace --locked` 通过；前端全量 307 文件、3,290 项通过，2 项真实文件测试默认跳过（ARPL 真实文件测试已显式开启通过，VMAP 在 M2 已通过）。补充效果到期测试和播放交互定向回归 46 项通过。严格 Clippy、vendor 27 项测试及清单验证、`pnpm lint`、`pnpm build`、绑定生成通过；中英文翻译无缺项，新增回放图层区域 axe 0 violations。
- M2 远端 CI 与依赖审计已全绿。本批 M1 提交后继续核对对应远端检查。

M1/M2 完成不等于 3D 功能完成：M0 的三个落地残差仍待解释；M3 的 campath/遮挡检测、M4 的 3D 视图、M5 的剪辑预演仍未完成。

### 2026-09-29 · M3 机位采样基础

- `crates/hlae/src/camera_sampling` 提供唯一的 Rust `sample_camera_shot`，默认使用方可取 `CAMERA_PREVIEW_FPS=30`。位置/FOV 是零端点速度的 C2 三次样条；旋转为 HLAE 的 qspline，保留半球选择、1e-6 容差和最多三次角速度迭代。每个镜头持有自己的系数，不使用上游的全局临时缓冲。
- XML 编译和采样共用六位小数数值约定，包含非 64/128 tick rate 的时间结点；对非法镜头、速率及超过 100,000 个采样的请求在分配前拒绝。输出位置、Source 轴系四元数、FOV、相对秒和 Demo tick，前端无需重做 campath 插值。
- 固定当前受管 HLAE v2.191.1 源码 `b97636852b8eecae09285b5a386192bb285638eb`；开发脚本编译上游 `AfxMath.cpp` 生成 8 组、**842 个**独立对照样本，覆盖非均匀时间、yaw 跨界、静止、极点附近姿态、线性/三次模式和六位小数时刻。逐分量误差阈值 **2e-9** 全部通过；另验端点静止、并发调用及请求上限。MIT 与 qspline CC0 声明已保留，生产应用不引入 C++ 运行时或 HLAE 二进制。
- 真实 Mirage 决赛第 20 回合 tick 160800–161310，现有机位规划函数根据 FalleN 和对手实体生成 Flyby/Crane，两者分别得到 **241 个 30 fps 机位**。结果保留于本机忽略目录的 `real-campath-samples.json`，供后续碰撞验收使用。
- HLAE 全套测试、严格 Clippy 和 TypeScript 绑定生成通过。M1 远端 web、Rust 与依赖审计已通过；desktop 仍在运行。机位采样仅完成 M3 数学基础，尚未宣称遮挡诊断、自动修正或游戏实拍比对完成。

### 2026-09-29 · M3 几何查询基础

- runtime 使用 `parry3d 0.28.0` 构建三角形 BVH，直接消费 M2 的 VMAP。使用 alloc 与 deterministic math 特性，不启用默认的额外形状处理和 SIMD 依赖。`RuntimeSourceAssetPort` 按现有地图来源指纹保留一个 BVH；并发请求复用同一 Arc，换图或显式重建会淘汰缓存引用，仍在运行的查询可以完成。
- 每个 Rust campath 采样返回距墙距离、是否不足 16 单位、与前一机位之间是否穿过表面、头部/胸部遮挡和目标是否在视锥内。视线是带 1/8 单位端点余量的有限线段，双面查询；视锥沿用 Source 的 +X 前、+Y 左、+Z 上和基于 4:3 的 FOV，宽屏水平扩张与受管 HLAE `ScaleFovInverse` 对应。
- 目标位置只在相邻且间隔不超过 32 tick 的有效存活观测间插值。不存在、死亡或缺数据时返回未知，不能报告成无遮挡。头/胸为站立及蹲伏的简化取点，不声称复原角色骨骼；仍不模拟烟雾的视觉遮挡。
- **没有把地图三角形汤当作闭合实体**：Parry 的 signed-distance 内外判断要求闭合、正确绕序的流形网格。当前只可靠报告贴墙及相邻机位穿面，完整「墙内或贴墙」验收继续未勾选；穿面次数也不等于进入实体次数。
- 同一真实 Mirage / FalleN / tick 160800–161310 的 241 帧路径：Flyby 有 76 个贴墙采样、2 次穿面、42 个头胸同时遮挡采样、135 个目标出画采样；Crane 分别为 111、3、154、195。debug 构建 BVH 341 ms，两条路径各查询 7 / 5 ms。证据保存在本机忽略目录 `artifacts/simple-3d/real-camera-diagnostics.json`。这是本机静态物理几何上的诊断，尚未经 CS2 实拍确认。
- 合成回归覆盖双向射线、有限长度、贴墙阈值、跨帧穿面、旋转/宽屏视锥、目标缺失/死亡/间隙和非法网格。真实 API 测试额外验证并发 BVH 复用及显式重建失效。Agent、录制规划自动修正和片段属性尚未接入，M3 仍未完成。
- 本地 runtime 全量 257 项通过、8 项真实环境测试默认跳过；本批涉及的两项真实几何/镜头测试均另行显式开启通过。runtime 全目标严格 Clippy 通过。对应远端检查在提交后继续核对。

### 2026-09-29 · M3 自动修正、生产入口与片段属性

- 预演 API、Agent 和 HLAE 录制共用一个 `plan_camera_scene`。先采样原镜头，再检查有限组收近机位与替代风格；不会以更差的遮挡、出画、贴墙或穿面结果换取另一项改善。四个控制点仍不够时，跟随候选使用全部已观测轨迹点，再由同一个 HLAE 样条采样器检查。没有几何时保留原镜头并返回明确的未检查原因；诊断不会禁止录制。
- 新增 proposal 预演和 Project Clip 预演两条只读入口。Project 请求必须携带当前 revision，完成后再次核对 Head；返回 Project、Timeline Clip、revision、实际机位和检查结果。前留白、后留白、目标身份、单回合解析来源和实际录制宽高比沿用生产录制逻辑，没有另一套预演裁剪或相机插值。
- Agent 原来的“四个空间样本计数”校验已移除，改用生产预演入口；`replace_story_timeline` 返回每个实际 Clip 的 `cameraDiagnostics`，含请求/最终风格、自动调整、问题区间和未知原因。仍由既有 Project Patch、Edit Lease 和 Agent 运行时负责写入。成片 metadata 保留实际采用的风格和检查摘要。
- 同一 Mirage / FalleN / tick 160800–161310，整场密集数据上的原 Flyby `(穿面 2, 贴墙 76, 头胸同时遮挡 42, 出画 135)` 和 Crane `(3,111,154,195)`，均自动改为沿轨迹的 Tracking；各 241 个采样的四项残余计数全部为 0。保留了原镜头诊断，未把这项结果泛化为所有镜头均能修复。
- 另外通过**实际 API → 当前生产 worker → 单回合回放 → 本机 Mirage VPK → 自动修正**完整链路验证：Flyby 原有 5 个问题区间、Crane 7 个，两者修正后均为 0；debug 测试构建下首请求约 27.1 秒（含解析及地图准备），第二请求约 302 ms。使用内存数据库和临时缓存，没有写现有用户数据库。结果在忽略目录 `artifacts/simple-3d/real-camera-api.json`。
- 片段属性现显示自动调整、剩余问题、无法检查原因与重试；旧 Head 的晚到响应不会显示在新 Head 上。录制设置变化、地图重建会使检查缓存失效。浏览器开发 fixture 由 Rust 生产规划器从合成地面生成，TypeScript `satisfies` 校验类型，不含游戏资源或第二套数学实现。
- 浏览器验证 1440×900 与 1000×700、浅色和深色：正常/残余问题状态可读，录制入口保持可用，镜头检查区域 axe 0 violations、无浏览器错误。无法检查、重试和旧 Head 响应由交互测试覆盖。中英新增 18 条文案齐全。
- `cargo test --workspace --locked`、相关全目标严格 Clippy、绑定生成和格式检查通过；前端 308 文件、3,293 项通过，2 项真实文件测试默认跳过；lint 和 build 通过。原有 ProjectWorkspace 大包提示仍存在。上一批 `daaa19a` 的完整远端 CI 与依赖审计已通过；本批提交后继续核对。

M3 仍有两项重要未完成：开放三角形网格的可靠实体内部判定，以及 `mirv_campath draw` 游戏实拍对照。M0 的坐标残差、M4 3D 视图和 M5 Program Monitor 预演继续实施。

### 2026-09-29 · M4 共享场景与回放页接入

- 新增唯一的 `domain/scene3d` 渲染器与视图。Three.js 0.186.1 按需加载，当前生产构建将其放入独立约 570 kB / gzip 142 kB 的场景块；浏览器未开启 3D 时不请求该渲染器。保留 MIT 声明，不打包本机游戏资源。
- VMAP 索引和顶点数组直接用于网格，不复制坐标数组或分配大型顶点法线缓冲；面法线明暗由 flat shading 完成。选手为队伍色胶囊体，包含朝向、视线与选中标记；飞行轨迹复用已有回放轨迹函数并保留 Z，烟雾为半透明球体、燃烧为地面贴片。缺少几何时同一个渲染器只显示选手与机位。
- Source `(X,Y,Z)` 映射到 Three `(X,Z,-Y)`，相机完整保留 Rust 四元数的前向、上向和 roll。前端只选择已有机位采样，不重新插值 campath。回放页已接入自由、跟随与选手第一人称视角；生成镜头的机位视角仍需 M5 提供实际片段入口，因此对应视角验收继续保留未完成。
- 回放与 3D 共享一个时钟：已有 RAF 时钟逐帧更新可读取的时间，React/2D 仍按 32 ms 发布。暂停与手动跳转使用同一权威时间；渲染器不自行推进进度。暂停静止或离开可视区域时不重复提交绘制，移除视图会释放 RAF、监听器、几何、材质及 WebGL 上下文。
- 真实 Mirage / 第 3、20 回合的 ARPL 与 VMAP 在 Chrome 中验证了建筑、选手与烟火示意。剖切曾与水平碰撞面重合产生碎点，现将可视剖切面放在 VMAP 量化层之间；这只改变自由/跟随视角的展示，不修改地图坐标，也不用于机位视角或碰撞诊断。1100×700 使用内容容器宽度排布，避免 3D 被挤到屏幕外。
- 最终播放态 Chrome 探针在本机 RTX 5060 Ti / D3D11 上记录 4 秒 657 次绘制，约 **164 fps**，帧间隔 p95 **9 ms**，JS 堆约 **122.7 MiB**；暂停静止时 4 秒 0 次绘制。真实销毁检查确认画布断开、上下文释放、后续绘制为 0。截图和探针在本机忽略目录 `artifacts/simple-3d/m4-*`，检查区域 axe 0 violations。**这不是 WebView2 性能验收。**
- 已为原生验证构建独立标识的桌面程序、当前发布解析器，并在独立数据库中通过现有 Storage API 装入校验过的真实 Demo 与生产分析记录。原生 3D 性能测量尚未执行，`WebView2 60 fps / 300 MB` 门槛保持未勾选；Chrome 指标不能代替它。
- 前端全量 311 文件、3,302 项通过，2 项真实文件测试默认跳过；新增数学、时钟、生命周期、无几何及缓存刷新失败回归通过。lint、构建通过，中英 2,393 条文案无缺项。场景按需块及原有 ProjectWorkspace 大包提示仍保留。
- 上一批远端 Rust 检查暴露旧取消测试的墙钟断言不稳定：在预期的 20 ms 取消错误已返回后仍断言总耗时 <250 ms。受控延迟复现后，改为虚拟时钟精确校验 20 ms，并用可控释放/完成信号验证迟到编码器无法发布输出。生产取消策略不变，`8ea5e10` 的 web、Rust、桌面 CI 和依赖审计均已通过。

M4 的渲染基础已接入，但原生性能门槛和生成机位的实际入口仍未验收；M0 残差、M3 游戏实拍与实体内部判定、M5 时间线预演仍继续实施。

### 2026-09-29：M5 录制画幅基础

- 共享 `Scene3DView` / `Scene3DRenderer` 接受录制画幅；机位模式按原画幅居中显示，保持 Source 垂直 FOV，面板变化不会拉伸或裁掉构图。自由与跟随模式继续填满视口。
- 视口与拾取使用同一画幅计算，留边不参与选手拾取；重绘先清理留边，避免尺寸或模式切换残留旧画面。画幅更新复用已有渲染器，不新增播放时钟。
- 定向验证：场景数学与视图交互共 10 项通过，覆盖 16:9、4:3、竖屏画幅和不重建渲染器；Web lint、分层检查、类型检查通过。
- 这只是 M5 的共享渲染基础。片段属性/录制弹窗入口、真实片段数据、视锥与问题区间、Program Monitor 预演池和原生画面验收尚未完成，M5 清单保持未勾选。

### 2026-09-29：M5 属性与录制确认预演、回合尾部修复

- 片段属性与录制确认共用 `CameraPreviewViewport`。属性面板通过已有 Timeline 源时间换算联动播放头，并限制在片段源入点/出点；确认弹窗可切换本次范围中的片段和拖动完整录制区间。两者都显示「预演」，不建立新的播放时钟或 Project 写入模型。
- `CameraPlan` 是录制与预演共用的原生规划结果；`CameraPreview` 另携带实际录制区间、画幅、目标选手和分析 producer 身份。POV 不生成 campath，直接使用该 producer 的选手位置、pitch/yaw 和输入状态。Project 入口继续在计算前后校验 Head revision。
- 生成机位在自由/跟随视角显示原生采样轨迹、当前视锥，以及原生诊断发现问题的红色区间。前端没有第二套样条或遮挡算法；旧 `CameraPathLayer`、测试和导出已删除。新增真实 Three 场景图回归测试复现并修复了暂停时 campath 切到 POV 后自身胶囊仍可见的问题，同时验证画幅、最新时间合并和绘制后就绪通知。
- 实际 Mirage 高光复现：合法 Capture Intent 为 `160800..161502`，原选中回合帧却止于统计 RoundEnd `161310`，丢失 3 秒可录制尾部。现在录制规划与预演统一读取 completed producer 的密集回放，并只截取规划需要的帧及前后括号帧；整场采样使用与录制相同的下一回合开始/verified EOF 边界。`replay-cache-v3` 使旧的缺尾部缓存失效，ARPL wire 仍为 v2。
- 新增 producer 绑定的 `GET /api/analysis-runs/{id}/replay.bin`，与既有 Demo 回放共用提取器、缓存和 ARPL 编解码器。RRPL 保留 Agent 所需的经济/装备等逐回合证据；没有新增 RRPL 前端解码或兼容转换。不同片段通过相同 producer Query Key 共用解码数据。
- 原生真实 Demo/地图 API 回归通过：Flyby、Crane 均为 241 个机位采样，原始问题各 8 段、修正后剩余 0 段；POV 无 campath，覆盖到 `161502`，验证区间采样间隔不超过 16 tick。新 ARPL 为 **1,094,417 bytes**，仍小于此前 v1 的 **1,841,021 bytes**。证据为 `artifacts/simple-3d/m5-capture-tail-{red,green}.log`、`m5-real-camera-api.json`、`m5-real-run-replay.bin`。
- 浏览器使用上述真实 API 产物和本机 Mirage VMAP 检查了机位、自由视角、POV、明暗主题和 1100×700。发现确认弹窗的预演被纵向内容挤出后，改为确认信息与预演并排；最终 `m5-full-capture-tail.png` 显示完整画面和 `10.97 / 10.97 s`。Scoped axe 为 27 项通过、0 个 violation；一个颜色判断因图标邻接需人工核查，实测文字对比度 **6.60:1** 且图标不重叠。浏览器无运行时错误。这不是 WebView2 性能或 CS2 实拍验收。
- 本地验证：完整 Web **312 文件、3306 通过、2 跳过**；`pnpm lint`、`pnpm build`、规范绑定生成、`cargo test --workspace`、严格 workspace/all-targets Clippy 和普通桌面 debug 构建通过。Three 仍为延迟加载 chunk（577.18 kB、gzip 143.82 kB），已有大 chunk 提示保留。

M5 的 Program Monitor 稳定预演池、最新跳转与上一帧保留仍待接入，Figma 同步尚未完成。M0 坐标/过滤验证、M3 实体内部与游戏实拍、M4 WebView2 性能门槛继续保留未完成。

### 2026-09-29：M5 Program Monitor 预演池

- 未录制片段接入现有 Program Monitor，场景按 Clip 与 revision 保持稳定实例，只读取既有 Timeline Transport。保留当前、相邻和上一呈现片段；新 Head、连续跳转和失败重试不能让迟到结果覆盖当前目标。
- 视频与场景替换均保留上一帧，直到目标实际绘制或视频定位完成；共享现有源时间/速度换算及变换、效果、转场函数。没有新增编辑写入模型或播放时钟。
- 全量 Web 验证记录为 313 文件、3316 通过、2 跳过；lint、构建通过，既有大 chunk 提示保留。本轮另行复跑 Program Monitor、真实 Three 场景和预演视口交互共 18 项全部通过，覆盖跨 Head、视频/场景互换、失败重试、池上限与最新目标。
- 上一提交 `36c0514` 的远端 CI 已确认通过。本批提交后的远端检查继续跟进。Figma 已有本机截图产物，但尚需重新读取远端画板确认；原生性能、M0 过滤/坐标和 M3 游戏实拍/实体内部判断仍未验收。

### 2026-09-29：WebView2 首轮实测与生产中文修复

- 重新构建当前桌面代码，使用独立 QA 标识、数据库及真实 Mirage Demo/本机 VPK，通过原生 IPC 加载 19,571 帧密集回放。先测 Vite 开发资源，再在同一个 WebView2 环境测 `pnpm build` 的生产前端资源；后端仍是 debug 构建，不把它描述为完整 release 包验收。
- 生产资源走查复现中文界面显示翻译 ID：中文启动分支加载空词典，开发宏附带的默认文案掩盖了问题。改为加载已编译的中文词典；移除默认文案的回归断言修复前 2 项失败、修复后 5 项测试通过。重新构建并刷新原生视图后，中文导航与回放控件恢复正常。
- 10 秒 WebGL clear 探针：开发资源 1,585 次绘制、p95 间隔 6.9 ms；生产前端资源 1,597 次绘制、p95 6.7 ms。该探针统计提交绘制，不等同于显示器实际呈现帧率。生产前端 JS 堆约 81.3 MiB，但 renderer 私有内存约 337.6 MiB / 工作集 400.1 MiB；GPU 子进程私有内存另约 208.4 MiB。因此 **300 MB 内存门槛未通过**，不得用 JS 堆数字代替整体内存验收。
- 原始证据保存于本机忽略目录：`m5-webview-{dev,dist}-{performance,memory}.json`、`m5-webview-dist-replay.png`、`m5-native-dist-build.log`、`m5-native-locale-build.log`。后续需做原生内存基线/场景增量剖析、完整 release 与更长播放复验。M4 性能项保持未勾选。

### 2026-09-29：M5 完成与 Figma 远端复核

- 重新读取 Figma 文件 `N05FPVtPTwWV3ONlE48Fwv` 的实际节点，并重新导出三处截图：Program canvas `997:5767` 的实例 `1178:11116`（544×260）、片段属性 `1164:11110` 的实例 `1178:11150`（334×320）、录制确认 `1164:11137` 的实例 `1178:11185`（571.2×320）。三处均为可见的 `CameraPreviewViewport` 实例，显示「预演」；属性和录制确认保留镜头检查、视角与位置控制，录制确认按钮与画面同时可见。截图检查未见重叠或裁切。
- 设计入口：[Program Monitor](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=997-5767)、[片段属性](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1164-11110)、[录制确认](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1164-11137)。本机复核截图为 `artifacts/simple-3d/m5-figma-verified-{program,inspector,recording}.png`。
- M5 清单完成：生产入口、旧图层删除、Transport/Clip/Head 预演池与最新目标、上一帧保留、预演角标、DESIGN 规则、Figma 同步与中英文案都有代码、交互或远端画板证据。2,394 条文案英文缺项为 0，本轮再次执行严格词典编译通过。M5 完成不代表 M0/M3/M4 的独立验收完成。
- WebView2 生产前端资源继续播放 30 秒，1 秒一次记录的 renderer 私有内存范围 **197.2–263.5 MiB**，均值 **243.5 MiB**，原始文件 `m5-webview-dist-steady-memory.json`。这说明此前 337.6 MiB 不是持续基线，但不能豁免该峰值，也不能代替宿主/GPU/其他 WebView2 进程的总量与完整 release 验收。M4 性能门槛继续未通过。

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
