# DevScape 数据结构说明

本文整理当前项目中与 `project/session` 相关的数据结构与流转逻辑，便于后续继续按“项目视图优先”演进。

## 1. 核心类型（Renderer）

定义位置：`src/renderer/src/types/index.ts`

### 1.1 DataSource

```ts
type DataSource = 'claude' | 'trae' | 'trae-cn'
```

表示会话来源工具。

### 1.2 Session

`Session` 是最细粒度数据单元，关键字段：

- `id`: 会话唯一标识
- `source`: 来源工具（`DataSource`）
- `projectPath` / `projectName`: 会话所属项目
- `startTime` / `endTime`: 时间范围
- `firstPrompt` / `lastPrompt`: 首尾提示词摘要
- `promptCount`: 提示词数量
- `totalTokens` / `inputTokens` / `outputTokens` / `cacheTokens`: token 指标
- `status`: `success | debug | error`（当前主链路只保留 `success`）
- `linesAdded` / `linesRemoved`: 代码变更行计数
- `messages?`: 详情面板使用的消息明细（列表接口默认剥离）

### 1.3 ProjectStats

`ProjectStats` 是按 `source + path` 聚合出的项目统计，关键字段：

- `name` / `path` / `source`
- `totalTokens`
- `sessionCount`
- `promptCount`
- `lastActive`
- `toolCallCount`
- `bashCallCount`
- `toolDensity`（`toolCallCount / promptCount`）
- `bashRatio`（`bashCallCount / toolCallCount`）

---

## 2. 后端解析与聚合（Main）

主要位置：`src/main/claude-parser.ts`

### 2.1 数据来源

- Claude：`~/.claude/projects/*/*.jsonl`
- Trae / Trae CN：`~/Library/Application Support/{Trae,Trae CN}/User/workspaceStorage/*/state.vscdb`

### 2.2 聚合规则

- 统一输出：`{ sessions: Session[]; projects: ProjectStats[] }`
- 项目聚合键：`projectKey = \`${source}:${path}\``
- 每个 session 会回填到对应 project 的统计累计值

### 2.3 状态筛选（当前行为）

在 Claude 解析后会先计算：

- `error`：出现 error 事件
- `debug`：`promptCount > 15`
- `success`：其他情况

随后主链路执行筛选：**仅保留 `success` session**，`debug/error` 不进入最终 `sessions/projects` 数据集。

> Trae 侧当前生成的数据天然标记为 `success`。

---

## 3. IPC 与加载链路

主要位置：`src/main/index.ts` + `src/preload/index.ts`

### 3.1 IPC 接口

- `get-sessions`: 返回 `{ sessions, projects }`，并剥离 `sessions[].messages` 提升列表性能
- `get-session-detail(sessionId)`: 按需返回消息明细 `messages`

### 3.2 Renderer Store

位置：`src/renderer/src/store/index.ts`

核心状态：

- 原始数据：`sessions`, `projects`
- 选择态：`selectedProjectKey`, `selectedSession`
- 过滤态：
  - `searchQuery`（当前语义：搜索 project）
  - `sourceFilter: 'ALL' | DataSource`（工具切换）

---

## 4. UI 结构与过滤语义

### 4.1 左侧列表（`SessionList.tsx`）

当前实际上是“**Project 列表 + 展开 Session**”：

- 顶部显示 `PROJECTS`
- 每个 project 可点箭头展开其 `sessions`
- 搜索框：`search projects...`，仅按 `project.name / project.path` 过滤
- Tab：`ALL / CLD / TRAE / TCN`，映射到 `sourceFilter`

### 4.2 右侧列表（`ProjectsList.tsx`）

- 与 `sourceFilter` 联动，仅展示当前工具的项目（`ALL` 时展示全部）
- 继续支持项目高亮与详情入口

### 4.3 中央地形（`TerrainView.tsx`）

- `sourceFilter=ALL`：混合绘制不同工具项目，按 source 上色
- 切换具体工具：仅绘制该工具下 `sessions/projects`
- 山体构建输入也基于过滤后的 `visibleSessions/visibleProjects`

---

## 5. 关键约定（当前版本）

- 数据主视角为 `project`，session 是 project 的子层级
- 项目唯一键统一用 `source:path`
- “工具切换”是一级过滤器（`sourceFilter`），影响左侧、右侧、地形三处
- session 状态字段仍保留在类型中，但当前数据源主链路仅收录 `success`

---

## 6. 可演进方向（建议）

- 若后续完全不再使用 `debug/error`，可将 `Session.status` 收敛为单值或改为可选，减少语义噪音
- 可增加 `ProjectDetail` 结构（例如最近 session、最近活跃时间、人类可读路径等），进一步强化“项目优先”的展示模型
- `searchQuery` 可考虑更名为 `projectQuery`，让状态语义与 UI 一致
