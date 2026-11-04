# SubTerra · 城市地下世界三维切片透视仪

**搜索世界上任何一座城市，从地狱到地表以下 80 米，逐层揭开它的地下世界。**

不是为某几个城市定制的演示，而是一个通用的城市地下透视仪：底图拖到哪儿，地下结构就在哪儿实时重建——地铁隧道、暗渠水系、道路隧道、市政管廊，全部取自真实的 OpenStreetMap 矢量瓦片。

Built with **MapLibre GL JS 6** + **Three.js** (custom layer) + **TypeScript** + **Vite**.

---

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc --noEmit && vite build -> dist/
npm run preview
```

需要 Node ≥ 20.19 与支持 WebGL2 的浏览器。

---

## 核心体验

1. **地表** — 打开就是一座城市的三维天际线（真实 OSM 建筑体块，含高度）。
2. **搜索任意城市** — 输入 `Osaka`、`Amsterdam`、`Bogotá`…… Photon 地理编码会飞到那儿并加载当地地下数据。
3. **按 `PageDown` 逐层下潜** — 地表 → 浅层市政 → 排水暗渠 → 地铁浅层 → 地铁深层 → 深层隧道 → 基岩层。每按一次降一层，城市体块随之淡出，地下管网浮现。
4. **`PageUp` 返回上一层**，`S` 回地表，`D` 一键潜入 74 米。
5. **点击/悬停管线** — 查看接触档案：类型、深度、深度区间、坐标、来源。

| 快捷键 | 作用 |
| --- | --- |
| `PageDown` / `PageUp` | 逐层下潜 / 上浮 |
| `F` | 聚焦搜索框 |
| `D` | 一键潜入 |
| `S` | 返回地表 |
| `A` | 自动扫描深度 |
| `R` | 重置视图 |
| `↑` `↓` | 微调深度（4 米/次） |
| 左侧「建筑体块」 | 开关 3D 城市天际线 |
| `Esc` | 关闭弹层 |

---

## 数据从哪来

这是本项目的技术核心。**全球地下数据不依赖任何需要 Key 或按城市预处理的 API。**

### 1. 矢量瓦片（主力，全球覆盖）

`src/services/tiles.ts` 直接从 OpenFreeMap 的 OpenMapTiles 矢量瓦片读取：

| 图层 | 字段 | 用途 |
| --- | --- | --- |
| `transportation` | `class` `subclass` `brunnel` `layer` | 地铁、铁路、地下道路 |
| `waterway` | `brunnel` | 被覆盖的河道 / 暗渠 |
| `building` | `render_height` `render_min_height` | 三维城市天际线 |

判定逻辑（`classify()`）以 **`layer < 0`（低于地表）** 为首要依据——大量地铁线只有 `layer` 没有 `brunnel`，只看 `brunnel` 会漏掉它们：

- `class=transit` / `subclass=subway|light_rail|monorail` 且低于地表 → **地铁**
- `class=rail` 且在隧道内 → **铁路隧道**
- `class=motorway|trunk|primary|...` 且在隧道内 → **道路隧道**
- `waterway` 且 `brunnel=tunnel|culvert|covered` → **暗渠**
- `class=path|service|track` 一律排除（步道、台阶、辅路从来不是地下设施）

实测一个 z14 瓦片的覆盖密度（每瓦片）：

| 城市 | 地铁 | 隧道 | 暗渠 |
| --- | --- | --- | --- |
| 纽约 | 12 | 21 | — |
| 伦敦 | 11 | 58 | 4 |
| 东京 | 6 | 24 | 11 |
| 巴黎 | 8 | 8 | 2 |
| 莫斯科 | 7 | 4 | 5 |
| 阿姆斯特丹 | 1 | 3 | — |

### 2. Overpass（可选增强）

`src/services/overpass.ts` 只在部分城市有明确 `tunnel:depth` / `depth:below_surface` 标注时，用实测深度覆盖推断值。它**完全可选**：五个镜像全部不可达时，瓦片数据独立成立，不影响任何功能。

### 3. 地理编码

`src/services/geocode.ts`：正向用 **Photon**（免 Key、支持 CORS），反向用 **Nominatim**（Photon 的反查端点对纯坐标请求返回 400）。

---

## 深度如何推断

**`layer` 是相对堆叠序，不是米数。** 这一点决定了整个模型。

各城市使用的 layer 范围差异极大：

| 城市 | layer 范围 |
| --- | --- |
| 上海 | −10 … −1 |
| 伦敦 | −7 … −1 |
| 重庆 | −4 … −2 |
| 纽约 | −4 … −1 |

早期版本用 `layer × 8.5 + 4` 线性换算，上海因此算出 **85 米**——远超实际。
现在的做法是按**该区域实际出现的 layer 范围做归一化**，映射到每类设施的真实深度带：

| 类型 | 深度带 |
| --- | --- |
| 地铁 | 8–42 m |
| 道路隧道 | 6–60 m |
| 暗渠 | 2–16 m |
| 管廊 | 3–26 m |

本区域最浅的负 layer 映射到带内浅端，最深的映射到深端，中间线性插值。
上海 −10…−1 因此得到 8.5–42.5 m，重庆 −4…−2 同样落在带内。

**关键：深度在整个区域范围内统一解析，而不是逐瓦片。** 同一个 OSM way 会
被切成多段散布在相邻瓦片里，逐瓦片解析会让它的各段得到不同深度，接缝处就
出现肉眼可见的断层。改为区域级解析后，实测 295 个多段 way 全部深度一致。

## 命名规则

`transportation_name` 图层**不含任何 transit 条目**——地铁的线路名不在矢量瓦片里。
早期版本按几何邻近给地铁匹配上方街名，产生了「泰山大道西段」标注地铁隧道的错误。

现在的规则：

- **地铁/管廊** → 模式 + 层号：`Metro bore · L-3`、`Monorail bore · depot`
- **道路隧道** → 按邻近匹配真实街名：`新泾路隧道`、`The Gill`
- 匹配半径收紧到 22 m，避免命中平行街道

## 地下 POI

除了"什么从地下穿过"，还展示了"地下有什么"。

OpenMapTiles 的 `poi` 图层记录了带负 `level` 的兴趣点——地下商铺、地铁站厅、
停车场、餐厅。这些是唯一描述地下空间**实际用途**的数据。

实测每区域可提取的地下 POI（去重后最多显示 24 个）：

| 城市 | 地下 POI |
| --- | --- |
| 纽约 | 24 |
| 上海 | 24 |
| 东京 | 76（原始） |
| 伦敦 | 69（原始） |

POI 以紫色标签呈现，与按深度着色的管网区分。深度按楼层估算：`|level| × 3.5 m + 3`。

## 命名规则

`transportation_name` 图层**不含任何 transit 条目**——地铁的线路名不在矢量瓦片里。
早期版本按几何邻近给地铁匹配上方街名，产生了「泰山大道西段」标注地铁隧道的错误。

现在的规则：

- **地铁/管廊** → 模式 + 层号：`Metro bore · L-3`、`Monorail bore · depot`、`Metro bore · siding`
- **道路隧道** → 按邻近匹配真实街名：`洪湖东路`、`The Gill`
- 匹配半径收紧到 22 m，避免命中平行街道

## 关于三维建筑

地面以上的城市体块来自 OpenMapTiles 的 `building` 图层（`render_height`），
以半透明 fill-extrusion 渲染，随开挖深度加深而淡出。

**覆盖密度因城市而异，差异很大。** 实测单个 z14 瓦片的建筑数量：

| 城市 | 建筑数 |
| --- | --- |
| 纽约 | 1524 |
| 伦敦 | 455 |
| 东京 | 163 |
| 上海 | 62 |
| 重庆 | 7 |

这不是渲染 bug，而是 OpenStreetMap 在各城市的建筑标注完整度不同——中国城市的
建筑轮廓在 OSM 上本身就稀疏。纽约能看到密集天际线，重庆只能看到零星体块。

左侧「建筑体块」开关可以完全关闭它，便于观察深层管线。

## 架构

```
src/
  main.ts                  UI 状态、DOM、任意区域加载、PageDown 分层
  types.ts
  data/cities.ts           10 个快捷入口城市（只是便签，不是支持范围）
  services/
    tiles.ts               矢量瓦片 → GeoJSON 地下要素（含并发限流）
    geocode.ts             Photon 正向 + Nominatim 反向
    overpass.ts            可选深度增强
  map/
    SubsurfaceLayer.ts     MapLibre CustomLayer（Three.js 场景 + 解析拾取）
    shaders.ts             管线 / 地面网格 / 扫描面 / 剖面 / 笼体 / 节点 的 GLSL
    basemap.ts             样式定制 + 全球 3D 建筑体块
    palette.ts             深度→颜色（GLSL 与 CSS 共用）
```

### 几个关键实现细节

**网络竞争** — 提取器与底图共享连接池。`tiles.ts` 用 4 并发闸门，并且首次加载等底图 `idle` 后才启动，否则底图瓦片会被挤掉、页面一片黑。

**style 重载** — 跨洲 `flyTo` 可能触发 MapLibre 重载样式，运行时添加的图层会消失。`onRemove` 因此**不销毁场景图**（只释放 renderer），`render()` 里惰性重建 renderer，另有 1 秒轮询兜底修复缺失图层。

**样式写入守卫** — 样式未加载完成时 `setPaintProperty` 会抛异常，而这些异常会静默中断整条渲染链（表现为全黑画布）。所有样式写入都包在 `isStyleLoaded()` 守卫和 try/catch 里。

**地面网格裁剪** — 开挖网格是一个单位平面，按孔径缩放。孔径外直接 `discard`，绝不覆盖底图；孔径放大到城市尺度时装饰密度自动衰减。

---

## 已知限制

- **深度是推断值**，不是测绘值。只有少数 OSM way 带明确 depth 标签。
- **矢量瓦片 maxzoom 14**，更细的线路在此级别已被简化。
- **单包 450KB gzip**，Three.js + MapLibre 占大头，尚未做代码分割。
- 部分城市（如阿姆斯特丹）地表电车没有地下段，早期版本曾把它们误判为地铁——现已通过 `layer`/`brunnel` 双重判据修正。

---

## 数据版权

底图与建筑体块 © [OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://openmaptiles.org/) / [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者（ODbL）。
地下拓扑来自同一套 OpenMapTiles 矢量瓦片，深度增强来自 [Overpass API](https://overpass-api.de/)（ODbL）。
地理编码 © [Photon](https://photon.komoot.io/) / [Nominatim](https://nominatim.openstreetmap.org/)。
栅格兜底 © Esri。
