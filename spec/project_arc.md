## 最原始的想法

<br />

分析这个 帖子 <https://x.com/poetengineer__/status/2036479827193090399> 和 我上传的视频
输出一个开发方案文档, 做一个 Electron app, 语言可以是 rust 用来收集和数据分析 + typescript用来展示
就是收集和汇总你本地的ai工具的对话过程和你的调试过程记录, 用比较炫酷的展示方案例如例子中的three.js 生成的点阵 terrain, 有筛选,记录和排序, 有工具使用的细节展示等等.
来源可以是 claude code, codex, trae, cursor 等, 后面可以扩展到笔记或者浏览记录, 做一个个人的dev as life 的 workmate

<br />

<br />

这份开发方案基于你提供的视频（呈现了一个极具赛博朋克和极客风格的“SESSION PULSER”控制台）以及打造 “Dev as Life” 个人助手的愿景。

系统将采用 **Rust** 作为高性能的底层数据引擎（负责 I/O 监控、日志解析和数据聚合），结合 **Electron + TypeScript + React + Three.js** 构建高交互、炫酷的可视化前端。

***

# 🌌 DevLife Workmate: AI 辅助开发全景可视化工作流方案

## 一、 系统架构设计

为了平衡前端复杂的 3D 渲染和后端密集的数据处理，架构设计如下：

- **展示层 (Frontend)**: React + TypeScript + TailwindCSS。利用 React 生态的丰富性构建复杂的面板。
- **可视化引擎 (WebGL)**: Three.js (或 React Three Fiber)。专门负责渲染中央的 `Activity Terrain` (3D 点阵/线框地形图) 和其他高级数据图表。
- **容器层 (Desktop Runtime)**: Electron (NodeJS)。提供跨平台的桌面级能力，负责窗口管理和进程间通信 (IPC)。
- **数据引擎层 (Backend/Core)**: Rust。作为核心数据采集器，通过 `napi-rs` 编译为 Node 原生模块直接嵌入 Electron Main 进程，或者作为 Local Sidecar (本地独立后台进程) 通过 WebSocket 与前端通信。
- **本地存储 (Database)**: SQLite (通过 Rust 的 `sqlx` 或 `rusqlite` 驱动)。轻量、快速，适合存储结构化的历史会话、Token 消耗和项目元数据。

***

## 二、 核心功能与模块拆解 (参考视频 UI 布局)

### 1. 全局数据仪表盘 (Top Metrics Bar)

- **统计核心指标**：展示总会话数 (Sessions)、总提示词数 (Prompts)、代码增删量 (Added/Removed lines) 以及消耗的总 Tokens。
- **动态实时更新**：随着后台 Rust 引擎监听到新的日志，数据实现脉冲式 (Pulse) 的数字跳动动画。

### 2. 3D 活跃度地形图 (Activity Terrain - 中间核心区)

- **视觉表现**：使用 Three.js 绘制黑底荧光色（绿/黄）的 3D 线框或点阵网格。
- **数据映射**：
  - **X/Y 轴**：分别映射时间和不同的项目/工具类型。
  - **Z 轴 (高度)**：映射 Token 消耗量或交互频次。形成“高山”的地方代表深度调试或重构的密集攻坚期。
- **交互**：支持鼠标拖拽旋转、滚轮缩放；悬浮某座“山峰”可显示该时间段的核心关键词（如：*Image Clustering UI Prototypes*）。

### 3. 会话信息流列表 (Session Cards - 左侧面板)

- **流式卡片**：按时间倒序排列的对话卡片，左侧带有指示灯（例如绿色代表成功解决，黄色代表仍在 Debug，红色代表报错）。
- **快速预览**：卡片上显示 First Prompt (首个问题) 和 Last Prompt (最终指令)，鼠标悬浮 (Hover) 展开完整 Prompt 上下文。
- **搜索与筛选**：顶部的全局 Search 可以对所有历史 Prompt 进行全文检索。

### 4. 聚焦详情页 (Drill-down View)

- **点击展开**：点击左侧卡片后，进入类似视频后半段的详情页，展示完整的 User 与 Agent (如 Claude Code) 的对话记录、代码 Diff、以及当前请求的 Token 消耗。

### 5. 热力图与项目统计 (Activity Heatmap & Projects - 底部与右侧面板)

- **Github 风格热力图**：支持按 Day/Week/Month 切换，筛选不同维度的活跃度（Cards, Files, Tokens）。
- **水平柱状图 (Projects by Token)**：右侧列出各个项目 (58 Total Projects) 的 Token 占比，快速识别资源消耗大户。

***

## 三、 Rust 数据采集引擎 (ETL 方案)

Rust 的核心任务是**无感、低耗**地收集散落在本地的各种 AI 工具数据。

1. **目录监听器 (Watcher)**:
   - 使用 Rust 的 `notify` 库，建立对关键配置和日志目录的后台监听。
2. **多源数据适配器 (Parsers)**:
   - **Claude Code**: 解析其存储在 `~/.claude` 目录下的 JSON/日志文件。
   - **Cursor / Trae**: 这些基于 VSCode 的变体通常将对话数据和索引存储在 `~/.config/Cursor/User/workspaceStorage` 或类似目录下的 SQLite 数据库或 IndexedDB 中。Rust 需要定期提取这些 DB 文件中的 `chat` 表数据。
   - **Codex / 命令行工具**: 拦截标准输出或读取特定的 stdout logs。
3. **数据清洗与聚合 (Processor)**:
   - 清洗 HTML/Markdown 标签，提取纯文本。
   - 计算 Token 消耗 (可使用 Rust 版本的 `tiktoken` 库进行精准估算)。
   - 归一化数据格式入库 SQLite：`[id, timestamp, tool_name, project_path, prompt, response, tokens_used, tags]`。

***

## 四、 Three.js "Terrain" 渲染技术细节

为了实现视频中极具科技感的 3D 地形，可以采用以下方案：

1. **数据准备**：将过去 30 天的时间划分为网格的 X 轴，将不同项目划分为 Z 轴，统计出每个交叉点的 Token 数作为 Y 轴高度。
2. **几何体生成 (PlaneGeometry)**：
   - 创建一个高细分度的 `PlaneGeometry`。
   - 遍历顶点，根据业务数据的高度值，修改对应顶点的 Y 坐标。
   - 为了平滑过渡，可以结合 Perlin Noise 算法，或者对离散数据进行二维高斯模糊平滑处理，让“山峰”看起来更自然。
3. **材质与渲染 (Material)**：
   - **Wireframe**：使用 `MeshBasicMaterial({ wireframe: true, color: 0xaaff00 })`。
   - **点云**：使用 `PointsMaterial` 配合自定义的发光贴图，结合 `Points` 对象渲染，能达到视频中边缘消散的粒子感。
4. **动画与性能**：
   - 使用 `requestAnimationFrame` 配合时间的流逝，给地形添加微小的上下起伏呼吸感 (Sine Wave)。
   - 开启抗锯齿，限制渲染帧率以减少 Electron 在后台时的 GPU 占用。

***

## 五、 演进路线图 (Roadmap)

### Phase 1: AI 研发雷达 (MVP)

- **目标**: 跑通 Electron + Rust 通信链路，完成 3D 渲染。
- **功能**: 专注对接 Claude Code 和 Cursor。实现视频中的核心 UI：左侧卡片列表、中间 3D 活跃地形图、总 Token 计算。
- **交付**: 一个可以实时跑在第二块屏幕上的炫酷 Dashboard。

### Phase 2: 知识图谱与全局工作流

- **目标**: 扩充数据源，深化数据分析。
- **功能**:
  - 接入本地终端执行记录 (Zsh/Bash history)、Git Commit 记录。
  - 自动为 Session 打标签 (Auto-tagging)，例如识别出是一次 "Bug Fix" 还是 "Feature Refactor"。
  - 引入关系图谱 (Nodes Network Garden)，展示不同 Project 和具体 AI 对话之间的关联。

### Phase 3: Dev as Life - 个人全景智脑

- **目标**: 从“研发工具”向“数字生活记忆”延伸。
- **功能**:
  - 扩展到浏览器历史记录采集、本地笔记软件 (Obsidian/Notion 本地缓存) 的接入。
  - 引入本地大模型 (如通过 Ollama) 定期对你的所有“数字轨迹”进行总结，每周生成一份专属的“个人研发与生活周刊”。

你可以先从搭建 Electron + TS 的空壳开始，用模拟数据 (Mock JSON) 跑通 Three.js 的点阵地形图，然后再逐步将 Rust 的本地目录监听挂载上去。需要针对某个具体工具（比如 Cursor 的日志位置）的解析逻辑深入探讨吗？

<br />

## 关于 claude code 的log存放

请自行探索

<br />

## 关于cursor trae 的log存放

这张截图非常有价值！Trae 的 Solo 模式展现了一个非常典型的、高度结构化的 Agent 工作流。左侧的任务流（Task List）带有明确的生命周期状态（任务完成、任务中断、等待操作），右侧则是具体的思考过程（Search workspace）、代码上下文（Go 语言的 `WorkflowErr` 结构体）以及 AI 的解释。

对于你的 “DevLife Workmate” 来说，这种自带**状态、时间戳和关联上下文**的数据简直是极品！

由于 Cursor 和 Trae 都是基于 VS Code 开源底座（VS Code OSS / VSCodium）进行深度定制的，它们的数据持久化机制在底层架构上是高度相似的。我们来深度解剖一下这两种工具的日志和对话存放机制，以及你的 Rust 采集器该如何去“偷”这些数据。

***

### 一、 核心共性：VS Code 的 `workspaceStorage` 机制

不论是 Cursor 还是 Trae，为了保持不同项目（Workspace）的上下文隔离，它们主要依赖 VS Code 原生的 `workspaceStorage` 机制。

这些聊天记录、Agent 任务列表，通常**不会**以纯文本（如 `.log` 或 `.txt`）的形式存放，而是被序列化为 JSON 之后，塞进了一个轻量级的 **SQLite 数据库**中。

核心目标文件通常是：`state.vscdb`

***

### 二、 Cursor 对话记录存放解密

Cursor 的对话数据（Chat, Composer 记录等）深度绑定在每个项目的工作区中。

**1. 默认存储路径：**

- **macOS:** `~/Library/Application Support/Cursor/User/workspaceStorage/`
- **Windows:** `%APPDATA%\Cursor\User\workspaceStorage\`
- **Linux:** `~/.config/Cursor/User/workspaceStorage/`

**2. 目录结构：**

在这个目录下，你会看到一大堆由随机哈希值命名的文件夹（例如 `1a2b3c4d...`）。每个文件夹代表你用 Cursor 打开过的一个项目。

在每个哈希文件夹内部，通常有：

- `workspace.json`: 记录了这个哈希值对应的**真实本地项目路径**（例如 `file:///Users/yourname/projects/my-app`）。
- `state.vscdb`: 这是核心！一个 SQLite 数据库文件。

**3. 数据提取逻辑 (Rust)：**

Cursor 将聊天数据作为键值对存在 `state.vscdb` 的 `ItemTable` 表中。

- 你需要用 Rust 连接这个 SQLite。
- 查询类似：`SELECT key, value FROM ItemTable WHERE key LIKE '%cursor.chat%' OR key LIKE '%aichat%'`
- 取出来的 `value` 是一个巨大的 JSON 字符串，里面包含了 `user_messages`, `ai_responses`, `code_snippets` 以及时间戳。

***

### 三、 Trae 数据存放解密 (结合你的截图)

Trae 作为字节跳动推出的 AI IDE，底层逻辑相似，但数据结构会为了它的特色功能（如 Solo 模式）做定制。

**1. 默认存储路径猜想：**

- **macOS:** `~/Library/Application Support/Trae/User/workspaceStorage/` (具体文件夹名称可能略有不同，如 `trae` 或带有字节相关的内部代号)。

**2. 针对截图中的数据提取点：**

看你提供的截图，Trae 的 Solo 数据层级更丰富，你的 Rust 引擎在解析 `Trae/../state.vscdb`（或者它自定义的全局存储库 `globalStorage`）时，需要重点关注以下反序列化结构：

- **Task List (任务列表):** 对应左侧面板。你需要寻找包含 `tasks` 数组的 JSON key。你可以从中提取出：
  - `title`: 如 "检查错误类型中的敏感内容检测"
  - `status`: 枚举值（completed, interrupted, waiting\_for\_user）-> **这可以直接映射到你 3D 地形图上不同颜色的节点！**
  - `timestamp`: 任务创建/完成时间。
- **Thought Context (思考与执行过程):** 对应右侧。寻找类似 `agent_steps` 或 `execution_logs` 的字段，里面包含了它执行了什么工具（如 `在工作区搜索 'type WorkflowErr struct'`）。
- **Code Diff/References:** 提取它贴出的 Go 代码片段，用于在你的 Dashboard 详情页做语法高亮展示。

***

### 四、 Rust 数据采集引擎 (ETL) 开发指南

为了让你的 Dashboard 能够丝滑地读取这些数据，你的 Rust 后端需要实现以下工作流：

1. **路径发现与映射 (Mapping):**

   使用 Rust 的 `walkdir` 遍历 `workspaceStorage` 目录。读取每个文件夹下的 `workspace.json`，建立一个 `Hash -> 真实项目绝对路径` 的哈希表 (HashMap)。

   *这样你在界面上展示时，显示的是你的 "biz/service/ai\_template" 项目，而不是毫无意义的哈希串。*
2. **SQLite 并发读取 (`rusqlite`** **+** **`serde_json`):**

   编写一个定时任务（或启动时执行的扫描器），使用 `rusqlite` 库连接每个项目的 `state.vscdb`。

   Rust
   ```
   // Rust 伪代码示例
   let conn = Connection::open(vscdb_path)?;
   let mut stmt = conn.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ?")?;

   // 针对 Cursor 和 Trae 设置不同的特征 key
   let rows = stmt.query_map(["%chat%"], |row| {
       Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
   })?;

   for row in rows {
       let (key, json_value) = row?;
       // 使用 serde_json 解析 json_value，提取时间和 token 消耗
   }

   ```
3. **增量更新机制 (防抖与性能优化):**

   由于 `state.vscdb` 在你疯狂写代码和 Chat 时会被频繁写入更新，你的 Rust 采集器**千万不要**一直锁死这个数据库。
   - 建议监听 `.vscdb` 文件的 `mtime` (修改时间)。
   - 当文件发生改变后，延迟 (Debounce) 几秒钟再去以**只读模式** (Read-Only) 打开 SQLite 提取最新追加的数据，避免和 Cursor/Trae 主进程抢占文件锁导致 IDE 卡顿。

**下一步建议：**

你可以先用一个简单的 SQLite 可视化工具（比如 DB Browser for SQLite）打开你电脑上 `~/Library/Application Support/Cursor/User/workspaceStorage/` 下的某个最近活跃的 `state.vscdb`，去 `ItemTable` 里翻一翻。

确认了 JSON 的具体层级结构后，你用 Rust 的 `serde` 定义一套对应的 Struct，数据解析的部分就轻而易举了！
