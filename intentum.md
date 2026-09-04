# intentum设计规格

> **intentum is a Pi-native product-building harness.**
> 它让一个 Designer 与多个独立、强能力的 Worker 协作，把用户的想法持续推进到可预览、可验证、可发布的产品。

项目工作名：

- **产品名：intentum**
- **Pi Package：`pi-intentum`**
- **主命令：`/intentum`**
- **项目状态目录：`.intentum/`**

“intentum”原意是把独立制作的部件严密连接成完整结构。这正好对应这个系统：Designer 负责整体结构，Worker 独立完成大块工作，QA 检查接口与实际体验，最后由集成层把成果拼成完整产品。

------

# 1. 项目定位

intentum 不是一个新的 coding agent，也不是一个简单的“多 subagent prompt”。

它是构建在 Pi Agent 之上的一层**产品开发控制系统**，负责：

- 与用户进行高质量的产品对话；
- 维护产品目标、架构、设计语言和决策；
- 启动多个独立 Pi Agent session 作为强 Worker；
- 控制并行、依赖、暂停、重规划和集成；
- 学习用户的 UI taste；
- 自动完成低成本、分层 QA；
- 通过简洁 TUI 向用户展示真正重要的信息；
- 将开发过程推进到 preview、review、ship 和后续 feature session。

Pi 本身已经提供模型调用、工具循环、session、compaction、运行中 steering、扩展机制、自定义工具和 TUI 组件。intentum 应该直接使用这些能力，不重新实现 agent runtime。Pi 的扩展可以注册命令、工具、生命周期事件、自定义 UI 和持久化 session entries；SDK 则可以创建独立 AgentSession、订阅事件、发送 prompt、steer、follow-up 和恢复持久化会话。([Pi](https://pi.dev/docs/latest/extensions))

------

# 2. 核心设计原则

## 2.1 强 Worker，不是微型 subagent

每个 Worker 都是一个完整、持久化、拥有独立上下文和工作区的 Pi Agent session。

Designer 不应该把工作拆成：

```text
先创建文件 A
再写函数 B
再修改函数 C
再运行测试 D
```

而应该给出一个完整的 outcome-based contract：

```text
实现可用于生产的邮箱登录流程。

必须包括：
- 登录、登出和 session 恢复
- 错误状态和 loading 状态
- 移动端可用
- 对应测试
- 不改变现有用户数据模型

你可以自行选择实现方法。
```

Worker 自己负责：

- 阅读项目；
- 制定局部计划；
- 调查相关代码；
- 实现；
- 测试；
- 修复；
- 提交成果；
- 报告风险。

只有当工作横跨清晰的接口边界，或者确实可以并行时，才拆给多个 Worker。

------

## 2.2 Designer 负责判断，Controller 负责机械调度

Designer 是“技术创始人 + 产品设计负责人 + principal engineer”。

Designer 应该做：

- 理解用户目标；
- 澄清真正重要的问题；
- 设计产品方向；
- 选择架构；
- 判断工作边界；
- 处理 trade-off；
- 评估 Worker 结果；
- 解释 checkpoint；
- 根据用户反馈重新规划。

Controller 应该做：

- 启动和恢复 Pi session；
- 创建 worktree；
- 跟踪 Worker 状态；
- 控制最大并行数；
- 暂停和恢复；
- 执行测试命令；
- 保存状态；
- 顺序集成分支；
- 收集日志和 QA artifacts；
- 更新 TUI。

不要让 Designer 花 token 反复询问：

```text
Worker 2 完成了吗？
Worker 3 现在是什么状态？
能否启动下一个任务？
```

这些都应该由普通 TypeScript 代码处理。

------

## 2.3 用户目标比初始架构更稳定

真正应该“锁定”的是：

- 产品服务谁；
- 要解决什么问题；
- 用户不想要什么；
- 成功标准；
- 关键限制；
- 产品设计哲学。

架构只能是：

```text
当前已批准的架构方向
```

而不是不可改变的真理。

如果 Worker 在实现中发现原架构不现实，应提交 architecture concern，由 Designer 判断：

- 局部调整；
- 建立 architecture decision；
- 暂停相关 Worker；
- 向用户请求决定；
- 或者继续原方案。

------

## 2.4 Chat 不是项目的唯一记忆

重要信息必须沉淀成短小、结构化、可版本控制的项目文件。

Designer 不应该依赖几万 token 的历史聊天来记住：

- 用户喜欢什么；
- 为什么选择这个数据库；
- 某个功能到底接受什么结果；
- 哪些东西被明确排除；
- Worker 当前在做什么。

聊天负责沟通，项目 artifacts 负责长期记忆。

------

## 2.5 Deterministic first，AI only where useful

普通代码能完成的事情，不要交给模型：

- 状态机；
- 队列；
- 文件路径；
- Git worktree；
- 运行测试；
- 解析测试结果；
- console error 收集；
- viewport overflow 检测；
- 网络失败收集；
- screenshot diff；
- Worker 状态聚合。

模型主要用于：

- 产品判断；
- 架构判断；
- UI 设计；
- 复杂实现；
- 未知问题探索；
- 模糊视觉问题判断；
- 测试思路生成；
- 失败原因分析。

------

# 3. 明确不做什么

首版不要实现：

- 自定义模型 provider 层；
- 自定义 agent tool loop；
- 自定义 session 文件格式；
- 自定义 terminal rendering engine；
- 自定义 Git；
- 分布式任务队列；
- Worker 自动创建 Worker；
- prompt 自我修改系统；
- 向量数据库式长期记忆；
- 复杂 event sourcing；
- 文件内容寻址存储；
- 每个文件的 SHA256；
- artifact cryptographic manifest；
- 提交签名和完整 provenance chain；
- 多节点一致性协议；
- 每次修改都跑全部测试；
- 每次 UI 变化都让强视觉模型看整页截图；
- 为了“可靠”而增加大量重复校验。

首版假设：

- 一个 intentum controller process；
- 一个本地 Git repository；
- 多个本地 worktree；
- 用户是 repository 的拥有者；
- Pi 已经处理模型、认证、session 和基础工具。

实际需要的可靠性措施只有：

- state 写入采用临时文件后 rename；
- Worker 使用独立 worktree；
- destructive command 和 production deployment 需要用户确认；
- 崩溃后不删除未集成 worktree；
- 测试失败保留日志和 trace；
- Git 用于 diff、branch、commit 和恢复。

Git commit ID 可以自然用于记录 Worker 的 base/head，但不要额外设计一套 hash 验证系统。

------

# 4. 整体架构

```text
┌──────────────────────────────────────────────────────┐
│                    Human User                        │
│       natural language / decisions / preview         │
└──────────────────────────┬───────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────┐
│                Pi Interactive Session                │
│                                                      │
│  Existing Pi transcript + editor + model runtime     │
│  intentum status widget + commands + control panels   │
└──────────────────────────┬───────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────┐
│                   Designer Session                   │
│                                                      │
│ Product vision · architecture · planning · review    │
│ User conversation · checkpoint summaries            │
└──────────────────────────┬───────────────────────────┘
                           │ intentum tools
┌──────────────────────────▼───────────────────────────┐
│                  Project Controller                  │
│                                                      │
│ State · scheduler · worktrees · sessions · QA        │
│ integration · pause/resume · preview · checkpoints   │
└───────────────┬───────────────────────┬──────────────┘
                │                       │
       ┌────────▼────────┐     ┌────────▼────────┐
       │ Worker Session │ ... │ Worker Session │
       │ own Pi session │     │ own Pi session │
       │ own worktree   │     │ own worktree   │
       └────────┬────────┘     └────────┬────────┘
                │                       │
                └──────────┬────────────┘
                           │
                  ┌────────▼────────┐
                  │   QA Pipeline   │
                  │ deterministic  │
                  │ + QA session   │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ Integration +  │
                  │   Checkpoint   │
                  └────────────────┘
```

------

# 5. 角色与权限

## 5.1 Human

用户可以：

- 与 Designer 正常对话；
- 查看 preview；
- 选择 UI 方向；
- 接受或修改 checkpoint；
- 暂停整个流程；
- 改变产品方向；
- 直接与某个 Worker 对话；
- 请求 bug session；
- 请求 feature session；
- 启动 shipping。

用户不需要：

- 理解任务图；
- 阅读所有 Worker 日志；
- 手动协调分支；
- 对每个技术选择作决定；
- 学习大量 slash commands。

------

## 5.2 Designer

Designer 是当前主 Pi session 中的角色。

权限：

- 读取所有 intentum project artifacts；
- 创建和修改 charter、architecture、feature spec；
- 创建 WorkContract；
- 启动 Worker；
- 向 Worker 发送 steering；
- 请求 QA；
- 请求 integration；
- 创建 checkpoint；
- 向用户提出 decision；
- 暂停受影响的工作。

限制：

- 不直接执行大量机械调度；
- 不因为一个小改动就生成十几个 Worker；
- 不替自己完成的工作做最终 QA；
- 不隐瞒风险；
- 不在没有用户输入价值时频繁打断用户；
- 不把 Worker 原始日志直接倾倒给用户。

------

## 5.3 Worker

每个 Worker 是独立的 Pi AgentSession：

- 独立 session；
- 独立 worktree；
- 独立 branch；
- 独立模型配置；
- 完整代码工具；
- 持久化上下文；
- 可以被 steer；
- 可以在后续继续修复自己的功能。

Pi SDK 已经支持独立 AgentSession、事件订阅、动态 steering、follow-up、abort 和持久化 SessionManager，因此 intentum 只需要封装这些能力，不需要实现自己的 agent execution loop。([Pi](https://pi.dev/docs/latest/sdk))

Worker 默认不能：

- 创建其他 Worker；
- 自行把代码合并到 main；
- 修改 project charter；
- 单方面改变公开 API、数据模型或核心架构；
- 直接向用户弹出问题。

需要产品决定时，Worker 调用：

```text
intentum_escalate
```

由 Designer 判断是否真的需要询问用户。

------

## 5.4 Feasibility Worker

Discovery 后、架构正式批准前，可以启动一个 Feasibility Worker。

它的任务不是实现整个项目，而是：

- 挑战 Designer 的方案；
- 检查主要依赖和技术风险；
- 阅读现有代码；
- 必要时做小型 spike；
- 找出隐藏成本；
- 说明哪些假设可能错误；
- 给出更现实的替代方案。

用户可以直接与它对话。

但是 Feasibility Worker 提出的 scope 变化必须回到 Designer，更新正式 artifacts，避免 Designer 和 Worker 各自持有不同版本的项目目标。

------

## 5.5 QA Session

QA Agent 必须是独立 session，不使用实现 Worker 的原有上下文。

它只接收：

- feature spec；
- acceptance criteria；
- 当前 preview；
- changed files 摘要；
- 测试结果；
- 已知风险。

默认不给 QA Agent `write` 和 `edit` 工具。

QA Agent 可以：

- 阅读代码；
- 运行预先允许的 QA 命令；
- 浏览产品；
- 创建 finding；
- 建议 reproduction；
- 提出遗漏场景。

QA Agent 不直接修复问题。确认 finding 后，再分配给实现 Worker 或 Fix Worker。

------

# 6. Pi 集成方式

## 6.1 作为 Pi Package，而不是独立 CLI

最终安装形式：

```bash
pi install npm:pi-intentum
```

开发阶段可以使用 Pi 的本地 extension loading。

Package 包含：

```text
- intentum extension
- role prompts
- skills
- TUI components
- controller
- QA adapters
```

Pi 本身保持宿主：

- 用户仍然运行 `pi`；
- 用户仍然使用 Pi 的输入框和 transcript；
- 模型 provider 和认证沿用 Pi；
- session 历史沿用 Pi；
- tool execution 沿用 Pi；
- compaction 沿用 Pi；
- theme 和 keyboard handling 沿用 Pi。

Pi 官方扩展系统允许加载 TypeScript 扩展，并提供 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 与 `@earendil-works/pi-tui` 等接口；Pi Package 也可以组合 extension、skill、prompt 和 theme。([Pi](https://pi.dev/docs/latest/extensions))

------

## 6.2 主 session 作为 Designer

当用户运行：

```text
/intentum init
```

当前 Pi session 切换到 intentum Designer mode。

intentum 注入：

- Designer role prompt；
- 当前 ProjectBrief；
- 当前 feature；
- pending decisions；
- active workers summary；
- 当前 checkpoint；
- intentum orchestration tools。

不要把整个 `.intentum/` 和所有 Worker transcript 一次性注入。

------

## 6.3 Worker 由 Pi SDK 创建

建议封装一个稳定的内部接口：

```ts
export interface WorkerRuntime {
  id: string;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: WorkerEventListener): () => void;
}
```

底层实现使用 Pi：

```ts
createAgentSession(...)
SessionManager.create(...)
session.subscribe(...)
session.prompt(...)
session.steer(...)
session.followUp(...)
session.abort(...)
```

这样将来 Pi API 变化时，只需要修改一个 adapter。

伪代码：

```ts
async function createWorkerRuntime(
  contract: WorkContract,
  worktreePath: string,
  model: ResolvedModel,
): Promise<WorkerRuntime> {
  const sessionManager = SessionManager.create(worktreePath);

  const { session } = await createAgentSession({
    cwd: worktreePath,
    model,
    sessionManager,
    resourceLoader: createWorkerResourceLoader(contract),
    tools: createWorkerTools(contract),
  });

  return new PiWorkerRuntime(contract.id, session);
}
```

具体参数类型以安装版本的 Pi SDK 为准，不要复制一套相似但独立的 runtime。

------

# 7. Project State

## 7.1 文件结构

```text
.intentum/
├── config.json
├── state.json
├── activity.jsonl
├── charter.md
├── architecture.md
├── quality.md
│
├── taste/
│   ├── profile.json
│   ├── direction.md
│   ├── tokens.json
│   └── references.json
│
├── decisions/
│   ├── D-001-auth-strategy.md
│   └── D-002-dashboard-density.md
│
├── features/
│   └── F-001-authentication/
│       ├── spec.md
│       ├── acceptance.json
│       ├── work.json
│       └── summary.md
│
├── checkpoints/
│   └── C-001.json
│
├── qa/
│   ├── findings.jsonl
│   └── baselines.json
│
└── runs/
    └── R-001/
        ├── result.json
        ├── failures/
        └── traces/
```

Pi session transcript 不复制进 `.intentum/`。

这里只保存 Pi session 的引用或路径：

```json
{
  "workerId": "W-002",
  "sessionRef": "...",
  "worktreePath": "...",
  "branch": "intentum/F-001/W-002"
}
```

------

## 7.2 State 数据结构

```ts
export type ProjectPhase =
  | "discovery"
  | "direction"
  | "architecture"
  | "build"
  | "verify"
  | "review"
  | "ship"
  | "maintain"
  | "paused";

export interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  projectName: string;

  phase: ProjectPhase;
  autonomy: "guided" | "balanced" | "autopilot";

  activeFeatureId?: string;
  activeCheckpointId?: string;

  workers: Record<string, WorkerRecord>;
  pendingDecisions: DecisionRequest[];

  schedulerPaused: boolean;
  updatedAt: string;
}
export interface WorkerRecord {
  id: string;
  kind: "feasibility" | "implementation" | "integration" | "fix" | "qa";

  status:
    | "queued"
    | "starting"
    | "working"
    | "blocked"
    | "paused"
    | "verifying"
    | "completed"
    | "failed"
    | "interrupted";

  featureId?: string;
  objective: string;

  sessionRef?: string;
  worktreePath?: string;
  branch?: string;

  baseCommit?: string;
  resultCommit?: string;

  progressSummary?: string;
  blocker?: string;
  updatedAt: string;
}
```

`state.json` 是当前状态来源。

`activity.jsonl` 只用于 debug 和审计，不用于重放整个系统：

```json
{"time":"...","type":"worker_started","workerId":"W-002"}
{"time":"...","type":"qa_failed","featureId":"F-001","count":2}
{"time":"...","type":"checkpoint_created","checkpointId":"C-004"}
```

不要把每个 token、每个工具输出、每个文件读取都写进去。

------

## 7.3 状态写入

实现简单的单进程 store：

```ts
class ProjectStore {
  async read(): Promise<ProjectState>;
  async update(
    updater: (state: ProjectState) => ProjectState
  ): Promise<ProjectState>;
}
```

写入过程：

1. 写入 `state.json.tmp`；
2. `fsync` 不是首版必须；
3. rename 为 `state.json`；
4. 更新 TUI。

不需要：

- SHA256；
- Merkle tree；
- 签名；
- revision checksum；
- event replay verification。

------

# 8. 产品生命周期状态机

```text
DISCOVERY
   ↓
DIRECTION
   ↓
ARCHITECTURE
   ↓
BUILD
   ↓
VERIFY
   ↓
REVIEW
   ↓
SHIP
   ↓
MAINTAIN
   ├── FEATURE SESSION ──→ BUILD
   └── BUG SESSION ──────→ VERIFY
```

任何阶段都可以进入：

```text
PAUSED
```

暂停后恢复到原阶段。

状态切换由普通代码控制，不由模型随意修改字符串。

例如：

```ts
const allowedTransitions: Record<ProjectPhase, ProjectPhase[]> = {
  discovery: ["direction", "paused"],
  direction: ["architecture", "discovery", "paused"],
  architecture: ["build", "direction", "paused"],
  build: ["verify", "architecture", "paused"],
  verify: ["review", "build", "paused"],
  review: ["ship", "build", "paused"],
  ship: ["maintain", "review", "paused"],
  maintain: ["build", "verify", "paused"],
  paused: [
    "discovery",
    "direction",
    "architecture",
    "build",
    "verify",
    "review",
    "ship",
    "maintain"
  ]
};
```

不要做成复杂 workflow DSL。首版一个明确状态机足够。

------

# 9. Designer 的对话协议

intentum 的重要价值之一，是教 Designer 如何与普通用户进行产品对话。

## 9.1 每轮对话模式

Designer 应遵循：

```text
Reflect → Identify uncertainty → Recommend → Ask/Act
```

即：

1. 用一句话复述自己理解的目标；
2. 找出当前真正影响方向的最大未知；
3. 提供一个明确建议；
4. 只有必要时才问一个问题，否则直接继续。

错误方式：

```text
请选择数据库、ORM、状态管理、认证方案、部署平台、
CSS 框架、测试框架和 API 架构。
```

正确方式：

```text
这个产品首先需要让学生在几十秒内完成记录，
所以我建议首版采用免注册的本地体验，再在需要同步时登录。

目前唯一会明显影响架构的问题是：
数据是否必须跨设备同步？
```

------

## 9.2 一次只提出一个重要决定

DecisionRequest：

```ts
interface DecisionRequest {
  id: string;
  title: string;
  question: string;

  options: Array<{
    id: string;
    label: string;
    consequence: string;
  }>;

  recommendation?: {
    optionId: string;
    reason: string;
  };

  blocking: boolean;
  affectedWorkIds: string[];
}
```

Designer 不应该把所有未知问题积累成大问卷。

------

## 9.3 决定分级

### Designer 可以自行决定

- 内部函数组织；
- 普通 dependency；
- 文件结构；
- 局部组件实现；
- 测试组织；
- 小型可逆技术选择。

### 应记录但不一定询问用户

- 数据结构变化；
- 内部架构调整；
- 性能和复杂度 trade-off；
- 新增基础依赖；
- Worker 提出的局部替代方案。

### 必须询问用户

- 产品目标变化；
- UI 方向明显改变；
- 删除用户功能；
- 收集新的用户数据；
- 付费设计；
- 不可逆 migration；
- production deployment；
- 公开 API 行为变化；
- 与用户之前明确表达的 taste 冲突。

------

## 9.4 ProjectBrief

每次 Designer 被调用时，只注入一份精简的 ProjectBrief：

```text
PROJECT
Name:
Target users:
Primary outcome:
Non-goals:

CURRENT PHASE
Active feature:
Current checkpoint:

DESIGN DIRECTION
...

ARCHITECTURE
...

ACTIVE WORK
- W-002 ...
- W-003 ...

PENDING DECISIONS
...

RECENT RELEVANT DECISIONS
...
```

建议控制在约 800–1500 英文词等价内容内。

详细内容保存在对应文件中，需要时再读取。

------

# 10. WorkContract 与 Worker 调度

## 10.1 WorkContract

```ts
export interface WorkContract {
  id: string;
  featureId: string;

  title: string;
  objective: string;
  why: string;

  userVisibleResult: string;

  scope: {
    inScope: string[];
    outOfScope: string[];
  };

  interfaces: string[];
  constraints: string[];
  acceptanceCriteria: string[];

  dependencies: string[];
  touchHints: string[];

  risk: "low" | "medium" | "high";
  preferredWorkerKind: "implementation" | "fix" | "integration";

  contextFiles: string[];
}
```

刻意不要加入：

```text
step1
step2
step3
step4
```

除非任务本身必须按固定顺序执行。

------

## 10.2 合理的工作粒度

好的 WorkContract：

```text
完成整个 onboarding vertical slice：
landing → account creation → first project → dashboard。
```

不好的拆分：

```text
W1 创建按钮组件
W2 创建输入框
W3 创建 API 文件
W4 修改一条 route
W5 添加一个测试
```

默认目标：

- 一个 feature 使用 1–3 个 Worker；
- 最大并行数默认 3；
- 一个 Worker 可以拥有完整 vertical slice；
- 只有接口稳定后才并行前端和后端；
- 高冲突路径不要同时交给多个 Worker。

------

## 10.3 简单依赖和冲突判断

使用：

- `dependencies`；
- `touchHints`；
- 当前 active worker 的路径；
- feature 边界。

例如：

```json
{
  "touchHints": [
    "src/auth/**",
    "src/routes/login/**",
    "tests/auth/**"
  ]
}
```

如果两个任务明显修改同一核心文件，Scheduler 顺序执行。

不需要构建：

- AST 级冲突预测；
- 文件 hash comparison；
- semantic dependency graph；
- distributed lock manager。

------

## 10.4 Worker 生命周期

```text
QUEUED
  ↓
STARTING
  ↓
WORKING
  ├── BLOCKED
  ├── PAUSED
  └── VERIFYING
         ↓
      COMPLETED
```

Worker 只在以下时机汇报进度：

- 完成重要阶段；
- 遇到 blocker；
- 发现架构问题；
- 需要 decision；
- 准备提交；
- 最终完成。

不要让 Worker 每次读文件或执行命令都向 Designer汇报。

------

## 10.5 Worker 完成报告

```ts
interface WorkerResult {
  workId: string;
  status: "completed" | "blocked" | "failed";

  summary: string;
  userVisibleChanges: string[];

  filesChanged: string[];
  testsRun: TestRunSummary[];

  resultCommit?: string;

  architectureConcerns: string[];
  remainingRisks: string[];
  suggestedFollowUps: string[];
}
```

Worker 必须报告事实，不要只说：

```text
Everything looks great.
```

------

# 11. Worktree 与集成

## 11.1 每个 Worker 一个 worktree

路径建议：

```text
~/.cache/intentum/<project-id>/worktrees/<worker-id>/
```

分支：

```text
intentum/F-001/W-001
intentum/F-001/W-002
intentum/F-001/integration
```

不要把 worktree 嵌套在 repository 内部。

------

## 11.2 集成流程

```text
Worker completes
→ targeted QA
→ result accepted
→ controller integrates into feature integration branch
→ integration QA
→ checkpoint
→ merge into user branch
```

集成由 Controller 执行确定性 Git 命令。

如果无冲突：

```text
直接 merge/cherry-pick
```

如果有简单冲突：

```text
启动 Integration Worker
```

Integration Worker 接收：

- 两侧 diff；
- feature architecture；
- interface contract；
- tests；
- 冲突文件。

它负责解决冲突并重新运行相关测试。

不要让 Designer 在聊天里手工拼 patch。

------

# 12. Human Interrupt 与 Replanning

## 12.1 Pause

用户输入：

```text
暂停一下
```

或：

```text
/intentum pause
```

Controller：

1. 停止启动新 Worker；
2. 将 Scheduler 标记为 paused；
3. 给活跃 Worker 发送 safe-pause steering；
4. Worker 完成当前原子操作；
5. 保存当前文件；
6. 汇报未完成状态；
7. 必要时创建 WIP commit；
8. 保留 session 和 worktree。

Pi 的 `steer()` 可以在 agent 正在运行时加入新的指令，并在当前 assistant turn 的工具调用完成后交给 agent；真正需要立即终止时再使用 `abort()`。因此 intentum 应区分“安全暂停”和“紧急终止”。([Pi](https://pi.dev/docs/latest/sdk))

------

## 12.2 修改方向

用户提出新方向后，Designer 生成 ReplanSummary：

```text
Changed:
- 登录方式从密码改为 magic link。

Still valid:
- 用户数据模型；
- dashboard；
- session storage。

Affected:
- W-002 authentication API；
- W-004 login UI。

Unaffected:
- W-003 dashboard shell。

Action:
- 暂停 W-002 和 W-004；
- 更新 auth decision；
- 为两个 Worker 发送 revised contract。
```

不要重启所有 Worker。

只处理真正受影响的工作。

------

## 12.3 用户直接与 Worker 对话

TUI 中选择 Worker 后：

```text
Talk to W-002
```

用户信息直接发送到该 Worker session。

如果只是询问实现：

```text
为什么这里使用 WebSocket？
```

Worker 可以直接回答。

如果用户改变需求：

```text
这里不要 WebSocket，改成普通 polling。
```

Worker 应调用：

```text
intentum_escalate({
  kind: "requirement_change",
  ...
})
```

Controller 暂停受影响工作，Designer 将变化写入正式 artifacts，再恢复 Worker。

这样允许直接对话，又不会产生两个互相冲突的产品真相。

------

# 13. Taste Engine：找到用户真正喜欢的 UI

Taste Engine 不应该尝试从一句“现代、简洁、高级”中猜出完整 UI。

它通过实际选择逐步学习用户偏好。

------

## 13.1 三层 Taste

```ts
interface TasteState {
  globalTaste: TasteProfile;
  projectDirection: ProjectDesignDirection;
  featureOverrides: Record<string, FeatureDesignOverride>;
}
```

### Global Taste

用户长期偏好：

- 更紧凑还是更宽松；
- 更克制还是更有表现力；
- 低圆角还是高圆角；
- 是否喜欢 card-heavy UI；
- 字体和视觉层级；
- 动画强度；
- 色彩饱和度；
- 工程感、编辑感或消费产品感。

### Project Direction

这个产品的目标用户和场景需要什么。

例如：

```text
用户本人喜欢深色、紧凑、工程感 UI，
但当前项目面向低年级学生，
因此保留强层级和低卡片化，
同时提高字号、点击面积和颜色提示。
```

### Feature Override

某个功能的特殊要求：

```text
主界面紧凑；
首次 onboarding 更宽松；
数据表格减少动画；
营销 landing page 可以更有表现力。
```

------

## 13.2 TasteProfile

```ts
interface TasteProfile {
  density: PreferenceAxis;
  spacing: PreferenceAxis;
  geometry: PreferenceAxis;
  elevation: PreferenceAxis;
  colorIntensity: PreferenceAxis;
  contrast: PreferenceAxis;
  typography: PreferenceAxis;
  iconography: PreferenceAxis;
  motion: PreferenceAxis;
  navigation: PreferenceAxis;
  contentTone: PreferenceAxis;

  likes: string[];
  dislikes: string[];
  references: TasteReference[];
}
interface PreferenceAxis {
  value: number;       // 0–100
  confidence: number;  // 0–1
  evidence: string[];
}
```

不需要训练单独的 preference model。

首版只需要简单更新：

```ts
function applyPreference(
  axis: PreferenceAxis,
  direction: -1 | 1,
  strength: number,
): PreferenceAxis {
  return {
    value: clamp(axis.value + direction * strength, 0, 100),
    confidence: clamp(axis.confidence + 0.08, 0, 1),
    evidence: axis.evidence,
  };
}
```

------

## 13.3 Taste Discovery 流程

### 第一步：参考收集

允许用户：

- 粘贴产品名称；
- 提供 URL；
- 上传 screenshot；
- 选择“没有参考”。

Designer 不应该简单复制参考产品，而是提取：

- 密度；
- 排版；
- 层级；
- 色彩；
- 导航；
- 组件形态；
- 动画；
- 用户明确喜欢和讨厌的部分。

------

### 第二步：生成三个明显不同的方向

必须使用相同：

- 内容；
- 信息结构；
- 关键流程；
- 页面数据。

只改变设计语言。

例如：

```text
Direction A — Dense Precision
紧凑、强层级、低圆角、键盘优先。

Direction B — Calm Editorial
宽松排版、较少边框、强调文字和节奏。

Direction C — Soft Product
更强视觉引导、柔和卡片、更多状态反馈。
```

不要生成三个几乎相同、只换颜色的版本。

------

### 第三步：实际预览

每个方向都必须是：

- 真实渲染；
- 可以点击；
- 至少覆盖一个关键流程；
- desktop 和 mobile 可查看。

TUI 只负责显示：

```text
[Open A] [Open B] [Open C]
```

实际视觉比较在浏览器中完成。

------

### 第四步：具体选择

不要问：

```text
你觉得哪个更好？
```

应问：

```text
整体上更接近 A 还是 B？

A 的哪些部分应该保留？
- 信息密度
- 导航
- 字体
- 色彩
- 组件形状

B 中有什么是你明确不喜欢的？
```

每次比较尽量只测试一到两个变量。

------

### 第五步：形成 Design Contract

输出：

```text
.intentum/taste/direction.md
.intentum/taste/tokens.json
.intentum/taste/profile.json
```

`direction.md` 应包含：

```text
Visual character
Information density
Layout principles
Component rules
Typography
Color behavior
Motion
Responsive behavior
Explicit dislikes
Approved reference screens
```

------

## 13.4 Golden Flow

在全面实现 UI 前，先实现一个完整的 golden flow：

```text
Landing
→ Sign in
→ Main action
→ Result
```

用户批准：

- 信息结构；
- 视觉方向；
- 交互节奏；
- responsive behavior；

之后才让多个 Worker 扩展其他页面。

这样避免整个产品完成后用户才说：

```text
我不喜欢这个风格。
```

------

## 13.5 Feature Session 中的 UI 规则

新增 feature 时，Designer 先判断：

```text
现有 Design Contract 是否足以覆盖？
```

如果足够：

- Worker 必须沿用现有 tokens 和 component rules；
- 不重新进行完整 taste discovery。

只有以下情况才开启小型 taste session：

- 新增完全不同的使用场景；
- 用户明确要求改变方向；
- 现有设计规则无法解决；
- feature 是独立营销或创意页面。

------

# 14. QA Engine：高覆盖，但低 token 消耗

核心原则：

> **测试由程序大量执行，模型只接收异常和不确定内容。**

------

## 14.1 Quality Contract

每个 FeatureSpec 都要生成：

```ts
interface QualityContract {
  featureId: string;

  scenarios: QualityScenario[];
  invariants: string[];

  supportedViewports: Viewport[];
  edgeTags: EdgeTag[];

  requiredSuites: string[];
  releaseGate: ReleaseGate;
}
```

场景：

```json
{
  "name": "successful login",
  "given": [
    "user is logged out",
    "valid account exists"
  ],
  "when": [
    "user submits valid credentials"
  ],
  "then": [
    "dashboard is visible",
    "session is created",
    "refresh preserves the session"
  ]
}
```

------

## 14.2 分层 QA

### Layer 1：Cheap deterministic checks

根据项目类型运行：

- build；
- type check；
- lint；
- changed-package unit tests；
- API contract tests；
- migration dry run；
- static analysis。

模型不读取成功日志。

成功只记录：

```json
{
  "suite": "typecheck",
  "status": "passed",
  "durationMs": 3812
}
```

------

### Layer 2：Targeted functional tests

根据 changed files、feature tags 和 WorkContract 选择相关测试。

例如：

```text
src/auth/**
→ auth unit tests
→ session integration tests
→ login E2E
```

不要每个 commit 都执行完整 suite。

完整 suite 只在：

- integration checkpoint；
- release candidate；
- 核心架构变化后；

运行。

------

### Layer 3：Browser flow tests

Web 项目优先使用 Playwright。

Playwright 已经支持：

- auto-retrying assertions；
- ARIA snapshots；
- screenshot comparisons；
- DOM snapshots；
- console 和 network 信息；
- trace viewer；
- failure trace 保留策略。

因此 intentum 不需要自行开发一整套浏览器录制和视觉 diff 系统。([Playwright](https://playwright.dev/docs/aria-snapshots))

核心流程：

```text
open page
→ perform action
→ assert visible state
→ assert route/state
→ collect console failures
→ collect failed requests
→ save trace only on failure
```

------

### Layer 4：DOM 与 layout probes

很多 UI bug 不需要视觉模型。

浏览器脚本直接检测：

#### Viewport overflow

```ts
document.documentElement.scrollWidth >
document.documentElement.clientWidth
```

#### 元素出界

检查元素 bounding box 是否超出 viewport。

#### 交互元素被遮挡

对按钮中心点和几个内部采样点执行：

```ts
document.elementFromPoint(x, y)
```

判断实际命中的元素是否为按钮本身或其子元素。

#### 文本裁切

结合：

- `scrollWidth > clientWidth`；
- `scrollHeight > clientHeight`；
- `overflow: hidden`；
- `text-overflow`；
- 是否明确允许 truncation。

#### 永久 loading

动作完成后超过场景 timeout，loading indicator 仍然存在。

#### Console 与 network

检测：

- uncaught exception；
- console error；
- 4xx/5xx；
- failed request；
- unhandled promise rejection。

#### Accessibility

重点检查：

- 可交互元素是否有可访问名称；
- 表单 label；
- 键盘焦点；
- focus trap；
- tab 顺序；
- modal 打开后焦点位置；
- Escape 是否关闭可关闭 overlay。

不要把所有规则都定义成 release blocker。Finding 要有 severity 和 confidence。

------

### Layer 5：Relevant edge matrix

不要为每个 feature 机械测试所有边际情况。

Designer 或 QA Planner 根据 feature 选择 tags：

```ts
type EdgeTag =
  | "empty-data"
  | "single-item"
  | "large-data"
  | "long-text"
  | "unicode"
  | "rtl"
  | "small-viewport"
  | "slow-network"
  | "offline"
  | "server-error"
  | "double-submit"
  | "refresh"
  | "back-navigation"
  | "expired-session"
  | "permission-boundary"
  | "concurrent-edit";
```

例如普通设置按钮不需要测试 large-data。

数据表格才需要：

- empty；
- one row；
- thousands of rows；
- long text；
- mobile；
- slow API。

------

### Layer 6：Visual regression

只对以下页面保存 visual baseline：

- 用户已批准的 golden flow；
- 核心 dashboard；
- 高价值 marketing surface；
- 容易出现布局回归的页面。

规则：

```text
截图出现差异
→ 先用像素和 DOM 数据定位变化区域
→ 截取局部 diff
→ 判断是否是预期变化
→ 模糊时才交给视觉模型
```

不要每次给强模型发送：

- 整个网站；
- 所有 viewport；
- 所有页面；
- 数十张高清截图。

------

### Layer 7：Independent exploratory QA

仅用于：

- release candidate；
- auth；
- payment；
- permissions；
- data deletion；
- 数据迁移；
- 核心用户流程；
- 高风险 feature。

QA Agent 的任务：

```text
尝试破坏产品，而不是证明实现是正确的。
```

它可以：

- 自由探索；
- 尝试意外顺序；
- 重复点击；
- 后退和刷新；
- 使用异常输入；
- 尝试跨权限访问；
- 寻找状态不一致；
- 对照 acceptance criteria 找遗漏。

低风险 UI 文案改动不需要启动强 QA Agent。

------

## 14.3 Finding 数据结构

```ts
interface QaFinding {
  id: string;
  featureId: string;

  status:
    | "suspected"
    | "confirmed"
    | "fixing"
    | "fixed"
    | "accepted";

  category:
    | "functional"
    | "visual"
    | "layout"
    | "accessibility"
    | "performance"
    | "security"
    | "edge-case";

  severity: "blocker" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";

  title: string;
  expected: string;
  actual: string;

  reproduction: string[];
  route?: string;
  viewport?: string;

  evidence: {
    screenshot?: string;
    trace?: string;
    console?: string[];
    failedRequests?: string[];
    testName?: string;
  };
}
```

------

## 14.4 Confirmed bug 的最低标准

一个 finding 标记为 `confirmed` 前只需要：

1. 可以稳定复现一次；
2. 如果怀疑 flaky，再复现第二次；
3. 明确 expected 和 actual；
4. 有至少一种证据；
5. 有最小复现步骤。

不需要：

- 反复运行十次；
- 为每个 finding 生成 hash；
- 多模型投票；
- 三个 Worker 独立验证；
- 建立复杂可信度证明。

------

## 14.5 FailurePacket

测试失败后，不把完整日志发送给模型。

先由普通代码生成：

```ts
interface FailurePacket {
  testName: string;
  route?: string;

  expected?: string;
  actual?: string;

  errorClass: string;
  topStackFrames: string[];

  consoleErrors: string[];
  failedRequests: string[];

  relevantLogTail: string[];
  changedFiles: string[];

  screenshotPath?: string;
  tracePath?: string;
}
```

只向模型发送：

- failure packet；
- 相关 feature spec；
- 相关代码路径；
- 必要截图。

简单去重 key：

```text
testName + route + errorClass + topStackFrame
```

不需要计算内容 hash。

------

## 14.6 Fix loop

```text
Finding confirmed
→ 判断 owner
→ 原 Worker 或 Fix Worker
→ 修复
→ 只重跑失败测试
→ 重跑相关 suite
→ finding 标记 fixed
→ integration checkpoint 再跑完整必要 suite
```

Worker 修复后必须说明：

- 根因；
- 修改；
- 新增或更新的测试；
- 仍然存在的风险。

------

# 15. TUI 设计

intentum 不重新实现 terminal UI。

Pi 已经提供 component rendering、focus handling、Text、Box、Container、Markdown、Image 和 overlay 等能力；extension context 还可以设置 status、widget、footer、title 和自定义 editor。intentum 应直接基于这些组件构建。([Pi](https://pi.dev/docs/latest/tui))

------

## 15.1 主界面原则

主界面保留 Pi 原有：

- transcript；
- markdown rendering；
- tool output；
- editor；
- history；
- keyboard interaction。

intentum 只添加：

- 顶部或 editor 上方的 compact status widget；
- intentum footer；
- decision card；
- 临时 control-center workspace；
- Worker、QA 和 checkpoint 的折叠消息。

不要做永久 sidebar。

------

## 15.2 Banner 与 Logo

intentum 的终端 logo 来自 `brand/ascii/`，两种尺寸，每种拆成 mark（`logo-*.txt`）、wordmark（`text-*.txt`）和合并后的 lockup（`banner-*.txt`）。规格与颜色规则见 `brand/README.md`，不要手绘或换字体。

小号 lockup（`banner-small.txt`，58 列 × 6 行）：

```text
####            _       _             _
#######        (_)_ __ | |_ ___ _ __ | |_ _   _ _ __ ___
    #####ooo   | | '_ \| __/ _ \ '_ \| __| | | | '_ ` _ \
    #####ooo   | | | | | ||  __/ | | | |_| |_| | | | | | |
#######        |_|_| |_|\__\___|_| |_|\__|\__,_|_| |_| |_|
####
```

大号 lockup（`banner-big.txt`）为 113 列 × 18 行，mark 用 `#`，point 用 `@`。

mark 中的 `o`（小号）/ `@`（大号）是 point，用 Signal red（ANSI 31，truecolor 下 `#E8302A` / 暗底 `#FF5148`）渲染；其余全部用默认前景色。wordmark 永远不上色。一个 logo 只有一个红点。

使用场景：

1. `/intentum init` 建立新项目后的第一帧；
2. `/intentum` 无参数、且项目尚未初始化时的欢迎页；
3. `pi-intentum --version` 和 `--help`。

不使用的场景：

- 每次 session 恢复时；
- status widget、footer、decision card、checkpoint card 内；
- 任何会随 transcript 滚动的地方。

banner 只出现一次，之后界面只用一个字形作为 intentum 的标识，例如 `⋗ intentum · my-app`。标识跟随 `INTENTUM_SYMBOLS` 字形集：检测到 Nerd Font（或显式 `nerd`）时用 nf-md-bullseye_arrow（U+F08C9），`unicode` 用 `⋗`（U+22D7），`ascii` 用 `>•`。

响应宽度：

| 终端宽度 | 显示 |
| --- | --- |
| ≥ 113 列 | `banner-big.txt` |
| 58–112 列 | `banner-small.txt` |
| 21–57 列 | `logo-small.txt` + 同一行右侧的 `intentum`（纯文本） |
| 12–20 列 | `logo-small.txt`；空间不足时不追加 wordmark |
| < 12 列 | 只显示 `⋗ intentum` |

检测方式是 `process.stdout.columns`；无法检测时按 80 列处理，即显示小号 lockup。

实现时直接读取 `brand/ascii/` 下的文件，用 Pi TUI 的 `Text` 组件按行渲染，point 字符用主题的 error/danger 色或直接 ANSI 31 上色。不要把 logo 硬编码进多个文件。

------

## 15.3 Focus View

默认聊天界面保持安静：footer 优先保留 phase、blocking decision 与异常数量，空间允许时再显示 identity 和其他 session 信息。editor 上方只在以下情况出现 attention widget：blocking decision、failed/blocked/interrupted Worker、等待 review 的完成结果。顺序固定为 decision → failure/blocker → review result。

`/intentum` 打开临时 command center。Overview 顺序固定为：

1. 唯一明确的 next step 与 primary action；
2. attention 与等待 review 的结果；
3. active work；
4. phase、feature、autonomy 等 project context。

Phase 不显示不可读的全流程缩写，只显示 previous → current → next 和 `4/8`。

------

## 15.4 信息优先级

```text
需要用户决定
    ↓
用户可见成果与 preview
    ↓
QA 风险
    ↓
当前 checkpoint
    ↓
Worker 活动摘要
    ↓
技术细节
    ↓
原始日志
```

主界面禁止实时滚动展示每个 Worker 的 tool calls。

------

## 15.5 响应式信息密度

- **Wide（≥100×22）**：fullscreen 双栏 workspace，attention/results 与 active work 并列；Workers/Decisions 使用列表 + detail。
- **Compact（≥60×16）**：fullscreen 单栏 workspace，保持相同优先级并允许纵向滚动。
- **Fallback（更小）**：不发布残缺 overlay，显示纯文本 status 与可用 slash commands。
- **Regular mode**：使用最大 100 列的居中面板，保留整行点击、滚轮和点击外部关闭；fullscreen 保持键盘优先。

所有 clipping、padding 与 wrapping 都按 terminal cell 和 grapheme 计算，不能切坏 CJK 或 emoji。焦点只能落在当前 viewport 内真实可见的 control 上。

------

## 15.6 Worker Panel

```text
WORKERS

W-002  Implementation  working
Authentication vertical slice
Last update: Core API complete; implementing session restore.

W-003  Implementation  verifying
Dashboard shell
Last update: Running responsive tests.

W-004  Fix             blocked
Mobile navigation
Blocker: needs decision D-004.

[Enter: details] [T: talk] [S: steer] [Esc: close]
```

Worker details 按需读取，优先显示：

- outcome summary；
- user-visible changes；
- test evidence；
- remaining risks 与 architecture concerns；
- suggested follow-ups。

branch、worktree、commit、session ref 等技术字段放在最后。加载、失败与重试必须在面板内有明确状态。

Designer streaming、active Worker 与 panel action 只使用低强度、具有状态含义的 pulse/spinner；`INTENTUM_REDUCED_MOTION=1` 时全部退化为静态 glyph。

------

## 15.7 Decision Card

一次只显示一个 blocking decision：

```text
DECISION REQUIRED

Authentication method

A. Magic link
   Easier onboarding, depends on email delivery.

B. Password
   Familiar, but adds reset and password security flows.

Designer recommends A:
The product prioritizes low-friction first use.

Affected work:
W-002, W-004

[1 Choose A] [2 Choose B] [P Preview] [D Discuss]
```

多个非 blocking decisions 放在 decisions panel，不要连续打断用户。

------

## 15.8 Checkpoint Card

```text
CHECKPOINT C-004

What now works
- Users can create an account.
- Login survives refresh.
- Errors are shown clearly.

Verification
- 34 tests passed.
- Mobile layout checked at 320px, 768px and 1440px.
- No open high-severity findings.

Remaining
- Email delivery still uses the development provider.

[Open preview] [Accept] [Request changes] [View evidence]
```

用户看到的是产品结果，而不是：

```text
Merged commits 09ba9d and f142ae.
Modified 27 files.
```

这些放在 debug/details。

------

## 15.9 自然语言优先

用户应该可以直接输入：

```text
暂停
继续
让我看看现在的版本
dashboard 再紧凑一点
W-002 为什么选择这个库
开始做导出功能
把这个 bug 修掉
准备发布
```

Slash commands 只是快捷入口。

核心命令：

```text
/intentum init
/intentum status
/intentum feature
/intentum preview
/intentum workers
/intentum qa
/intentum decisions
/intentum pause
/intentum resume
/intentum checkpoint
/intentum ship
/intentum debug
```

不要首屏展示所有命令。用户输入 `/intentum` 后再显示当前阶段最相关的 4–6 个操作。

------

# 16. intentum Tools

## 16.1 Designer Tools

建议最多 8 个清晰工具：

```text
intentum_project
intentum_decision
intentum_create_work
intentum_worker
intentum_request_qa
intentum_integrate
intentum_checkpoint
intentum_preview
```

### `intentum_project`

读取或更新：

- charter；
- architecture；
- feature spec；
- project direction。

### `intentum_decision`

创建、解决或取消 DecisionRequest。

### `intentum_create_work`

创建 WorkContract，并交给 Scheduler。

### `intentum_worker`

操作：

```text
start
steer
pause
resume
abort
message
inspect
```

### `intentum_request_qa`

创建针对：

- work；
- feature；
- checkpoint；
- release；

的 QA run。

### `intentum_integrate`

把已完成 Worker 结果加入 feature integration branch。

### `intentum_checkpoint`

创建面向用户的 review packet。

### `intentum_preview`

启动或打开项目 preview。

工具 schema 使用 TypeBox 定义必要字段即可。不要加入几十层嵌套 validation。

------

## 16.2 Worker Tools

Worker 使用 Pi 原有 coding tools，并增加：

```text
intentum_progress
intentum_escalate
intentum_complete
```

### `intentum_progress`

只在重要节点调用。

### `intentum_escalate`

报告：

- blocker；
- architecture concern；
- requirement ambiguity；
- interface conflict；
- destructive change。

### `intentum_complete`

提交结构化 WorkerResult。

------

## 16.3 QA Tools

```text
intentum_qa_run
intentum_qa_observe
intentum_report_finding
intentum_finish_qa
```

QA Session 默认没有 `write` 和 `edit`。

`intentum_qa_run` 只允许运行项目已发现并登记的 QA commands，避免 QA Agent 随意修改环境。

------

# 17. 项目命令发现

第一次初始化时，intentum 检查：

- `package.json`；
- lockfile；
- framework config；
- test config；
- build scripts；
- existing CI；
- Dockerfile；
- deployment config。

生成：

```json
{
  "runtime": "node",
  "packageManager": "pnpm",
  "commands": {
    "install": "pnpm install",
    "dev": "pnpm dev",
    "build": "pnpm build",
    "typecheck": "pnpm typecheck",
    "unit": "pnpm test",
    "e2e": "pnpm playwright test"
  }
}
```

用户或 Designer 可以修改。

发现一次后复用，不要每个 Worker 重新猜 package manager。

首版不要建立大量 framework-specific adapter。先支持：

- generic shell；
- Node/web；
- Playwright。

以后再加入 Python、Rust、mobile 等 adapter。

------

# 18. Feature Session

```text
User describes feature
        ↓
Designer clarifies outcome
        ↓
FeatureSpec + QualityContract
        ↓
Need new UI direction?
   ├─ No → reuse Design Contract
   └─ Yes → small taste session
        ↓
1–3 broad WorkContracts
        ↓
Workers implement independently
        ↓
Targeted deterministic QA
        ↓
Independent QA when risk requires
        ↓
Integration
        ↓
Checkpoint + preview
        ↓
Accept / revise / pause
```

FeatureSpec：

```text
Goal
Target user
User-visible behavior
Non-goals
Interaction flow
Design constraints
Technical constraints
Acceptance criteria
Relevant edge cases
Release impact
```

不要让 feature session 自动变成完整架构重写。

------

# 19. Bug Session

```text
User reports bug
→ reproduce
→ create finding
→ identify likely owner
→ assign Fix Worker
→ rerun failing scenario
→ related QA
→ checkpoint or direct merge
```

如果用户只提供自然语言：

```text
移动端菜单有时候打不开
```

QA 先尝试建立最小 reproduction。

确认不了时标记：

```text
suspected
```

不要让 Worker凭猜测大改代码。

------

# 20. Shipping

intentum 负责把“代码完成”推进到“可以发布”，但不替项目重新发明 deployment platform。

Ship Plan：

```text
Build command
Required environment variables
Database migrations
Preview result
Production command or CI workflow
Rollback method
Post-release smoke tests
Known limitations
```

Shipping 流程：

```text
Release QA
→ summarize changes
→ confirm migrations/destructive actions
→ run existing deployment command or workflow
→ smoke test production
→ create release checkpoint
→ enter maintain phase
```

自动化等级：

### Guided

所有 merge、deployment 和 destructive operations 都询问。

### Balanced

普通 merge 自动执行；production deployment 和 destructive operations 询问。

### Autopilot

普通功能流程自动推进，但以下仍然询问：

- production deployment；
- 删除数据；
- 不可逆 migration；
- secrets；
- 付费操作；
- 明显改变产品目标。

------

# 21. Token 与上下文效率

## Designer Context

只包含：

- ProjectBrief；
- 当前 feature；
- pending decisions；
- Worker 摘要；
- checkpoint；
- 相关 decisions。

不包含：

- 全部代码；
- 全部 terminal logs；
- 全部 Worker transcript；
- 所有旧 feature。

------

## Worker Context

Worker 接收：

- WorkContract；
- charter 摘要；
- architecture 相关部分；
- Design Contract 相关部分；
- 相关 decisions；
- repository 本身。

Worker 可以自行搜索 repository，不要提前把几十个文件塞进 prompt。

------

## QA Context

QA Agent 接收：

- QualityContract；
- preview；
- changed files；
- test failure packets；
- 相关截图或 trace；
- 已知风险。

成功日志不进入模型上下文。

------

## Session 复用

同一 feature 的修复优先继续原 Worker session，而不是每次创建新 agent。

例如：

```text
W-002 完成 authentication
→ QA 找到 refresh bug
→ steer W-002 修复
```

这样 Worker 已经理解相关代码。

Pi 本身支持 session persistence、树状会话、分支和 compaction；intentum 应保存 session 引用并利用这些现成功能，而不是把历史重新拼成自定义 prompt。([Pi](https://pi.dev/docs/latest/sessions))

------

# 22. 崩溃恢复

启动 intentum 时：

1. 读取 `state.json`；
2. 找出状态为 `starting`、`working`、`verifying` 的 Worker；
3. 检查对应 worktree 是否仍存在；
4. 检查 Pi session 是否可恢复；
5. 标记为 `interrupted`；
6. 向用户展示恢复摘要；
7. 恢复 session 或创建新的 recovery worker。

示例：

```text
intentum recovered an interrupted project.

Preserved:
- W-002 worktree and session
- W-003 completed commit
- QA failure trace

Needs attention:
- Preview server is no longer running

[Resume all] [Review workers] [Stay paused]
```

不要：

- 自动删除 worktree；
- 自动 reset 未提交文件；
- 仅因为 state 时间戳旧就丢弃结果；
- 运行复杂完整性扫描。

------

# 23. 推荐代码结构

```text
pi-intentum/
├── package.json
├── tsconfig.json
├── README.md
│
├── extensions/
│   └── intentum.ts
│
├── src/
│   ├── runtime/
│   │   ├── intentum-runtime.ts
│   │   ├── designer-runtime.ts
│   │   ├── worker-runtime.ts
│   │   ├── qa-runtime.ts
│   │   └── session-registry.ts
│   │
│   ├── controller/
│   │   ├── project-controller.ts
│   │   ├── scheduler.ts
│   │   ├── replanner.ts
│   │   └── lifecycle.ts
│   │
│   ├── state/
│   │   ├── schema.ts
│   │   ├── project-store.ts
│   │   └── activity-log.ts
│   │
│   ├── work/
│   │   ├── contract.ts
│   │   ├── worker-manager.ts
│   │   └── result.ts
│   │
│   ├── git/
│   │   ├── worktree-manager.ts
│   │   └── integration-manager.ts
│   │
│   ├── taste/
│   │   ├── profile.ts
│   │   ├── preference-update.ts
│   │   ├── direction-session.ts
│   │   └── design-contract.ts
│   │
│   ├── qa/
│   │   ├── command-discovery.ts
│   │   ├── quality-contract.ts
│   │   ├── test-selector.ts
│   │   ├── command-runner.ts
│   │   ├── playwright-runner.ts
│   │   ├── layout-probes.ts
│   │   ├── failure-packet.ts
│   │   └── finding-store.ts
│   │
│   ├── preview/
│   │   └── preview-manager.ts
│   │
│   ├── tui/
│   │   ├── status-widget.ts
│   │   ├── footer.ts
│   │   ├── control-center.ts
│   │   ├── decision-panel.ts
│   │   ├── workers-panel.ts
│   │   ├── qa-panel.ts
│   │   └── checkpoint-panel.ts
│   │
│   ├── tools/
│   │   ├── designer-tools.ts
│   │   ├── worker-tools.ts
│   │   └── qa-tools.ts
│   │
│   └── utils/
│       ├── process.ts
│       ├── paths.ts
│       └── ids.ts
│
├── skills/
│   ├── intentum-designer/
│   │   └── SKILL.md
│   ├── intentum-worker/
│   │   └── SKILL.md
│   └── intentum-qa/
│       └── SKILL.md
│
├── prompts/
│   ├── intentum-init.md
│   ├── feature-session.md
│   └── bug-session.md
│
└── tests/
    ├── state/
    ├── scheduler/
    ├── qa/
    ├── tui/
    └── fixtures/
```

------

# 24. Extension 入口骨架

以下是结构示例，不要求逐字复制：

```ts
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { intentumRuntime } from "../src/runtime/intentum-runtime.js";
import { registerintentumCommands } from "../src/tools/commands.js";
import { registerDesignerTools } from "../src/tools/designer-tools.js";

export default function intentumExtension(pi: ExtensionAPI): void {
  const runtime = new intentumRuntime(pi);

  registerintentumCommands(pi, runtime);
  registerDesignerTools(pi, runtime);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await runtime.onSessionStart(ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
}
```

遵守 Pi 的 lifecycle：不要在 extension factory 中直接启动长时间运行的 preview server、Watcher 或 Worker；在 session start 或明确命令中启动，并在 shutdown 时清理。Pi 官方扩展文档也要求避免在 factory 阶段启动长期进程。([Pi](https://pi.dev/docs/latest/extensions))

------

# 25. intentumRuntime 的职责

```ts
export class intentumRuntime {
  readonly store: ProjectStore;
  readonly controller: ProjectController;
  readonly scheduler: Scheduler;
  readonly workers: WorkerManager;
  readonly qa: QaManager;
  readonly preview: PreviewManager;
  readonly tui: intentumTui;

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    await this.store.loadOrCreate();
    await this.controller.recoverInterruptedWork();
    this.tui.mount(ctx);
    this.controller.start();
  }

  async dispose(): Promise<void> {
    await this.scheduler.pause();
    await this.preview.stopAll();
    await this.workers.dispose();
    this.tui.unmount();
  }
}
```

Controller 与 TUI 之间使用普通 event emitter：

```ts
type intentumEvent =
  | { type: "state_changed" }
  | { type: "worker_changed"; workerId: string }
  | { type: "decision_created"; decisionId: string }
  | { type: "qa_changed"; runId: string }
  | { type: "checkpoint_created"; checkpointId: string };
```

不需要为每个 token stream 建立全局 event log。

------

# 26. 实现阶段

## Phase 1：Pi-native skeleton

完成：

- Pi extension 加载；
- `/intentum init`；
- `.intentum/state.json`；
- Designer mode；
- compact status widget；
- project phase；
- charter 和 architecture artifacts。

暂不实现：

- 多 Worker；
- Taste Engine；
- Playwright；
- shipping。

------

## Phase 2：单 Worker vertical slice

完成：

- Pi SDK WorkerSession；
- 一个 Worker worktree；
- WorkContract；
- progress、escalate、complete；
- pause、steer、resume；
- Worker result；
- merge；
- 重启后恢复。

这是首个真正 end-to-end milestone。

------

## Phase 3：多个强 Worker

完成：

- Scheduler；
- 最大并行数；
- dependencies；
- touchHints；
- feature integration branch；
- integration worker；
- Worker panel；
- direct worker conversation。

不要先构建复杂 DAG UI。

------

## Phase 4：QA Engine

完成：

- 项目 command discovery；
- targeted test selection；
- structured command results；
- Playwright adapter；
- console/network collection；
- overflow 和 obscured-element probes；
- retain-on-failure trace；
- finding store；
- QA panel；
- fix loop。

使用一个 fixture app，预埋：

- 一个功能 bug；
- 一个移动端 overflow；
- 一个 duplicate-submit；
- 一个 console error。

验证 intentum 能发现它们。

不要添加 SHA 或 artifact integrity tests。

------

## Phase 5：Taste Engine

完成：

- TasteProfile；
- 三方向生成；
- browser preview；
- 用户选择；
- profile 更新；
- Design Contract；
- golden flow；
- UI checkpoint。

首版不要训练个性化模型。

------

## Phase 6：Feature、Bug 与 Ship Sessions

完成：

- `/intentum feature`；
- `/intentum bug`；
- release QA；
- ship plan；
- production confirmation；
- maintain phase；
- post-release smoke test。

------

# 27. intentum 自身的验收标准

首版完成时，必须证明：

1. 用户可以在正常 Pi 中安装并启动 intentum。
2. 不存在第二套 agent loop。
3. 不存在第二套 model provider/auth 系统。
4. 不存在第二套 terminal framework。
5. Designer 可以通过普通对话建立 charter。
6. Designer 可以启动一个独立、持久化 Pi Worker。
7. Worker 拥有独立 worktree 和 branch。
8. Worker 接收的是 outcome contract，而不是微型步骤。
9. 用户可以安全暂停、steer 和恢复 Worker。
10. 重启 Pi 后，项目状态和 Worker session 可以恢复。
11. 多个 Worker 可以在有限并行度下工作。
12. intentum 可以整合 Worker 结果。
13. QA 可以通过普通 runner 发现预埋功能 bug。
14. QA 可以发现移动端 overflow。
15. 成功日志不会大量发送给模型。
16. trace 和 screenshot 默认只在失败时保留。
17. UI taste 流程可以展示三个真实方向。
18. 用户选择会更新 project design contract。
19. 默认 TUI 不显示 Worker 原始日志。
20. 用户可以完成一次完整流程：

```text
idea
→ architecture
→ implementation
→ QA
→ checkpoint
→ feature revision
→ ship
```

------

# 28. 给 Coding Agent 的最终约束

实现 intentum 时严格遵守：

```text
1. Build on Pi Agent. Do not fork or reimplement Pi.

2. Use Pi extensions for commands, tools, events and TUI.

3. Use Pi SDK AgentSession for Designer-adjacent workers,
   QA workers and integration workers.

4. Every worker is a persistent first-class session with
   its own worktree. Do not model workers as disposable
   single-prompt subagents.

5. Give workers broad outcome-based contracts.
   Do not micromanage them with generated step lists.

6. Keep orchestration deterministic:
   state, queues, dependencies, process execution,
   worktrees and test selection belong in TypeScript.

7. Preserve user control:
   pause, steer, direct worker chat, replan and resume
   must be first-class operations.

8. Store durable product knowledge in small artifacts,
   not only in chat history.

9. Implement UI taste through rendered alternatives,
   concrete preference choices and a project design contract.

10. Implement QA as deterministic-first:
    run many tests with code, send only failures and ambiguous
    evidence to models.

11. Reuse Playwright for browser tests, screenshots,
    accessibility snapshots and traces.

12. Reuse Pi TUI components and the existing Pi editor.
    Do not build another full-screen terminal application.

13. Default UI must show only:
    current goal, checkpoint, QA risk, pending decision,
    worker summary and relevant actions.

14. Avoid unnecessary verification infrastructure.
    Do not add SHA256 manifests, content-addressed storage,
    cryptographic audit chains, distributed locking or
    elaborate event sourcing.

15. Prefer the smallest working system that can complete
    one real feature end-to-end before adding abstraction.
```

intentum 最关键的产品价值不在于“同时运行很多 AI”，而在于：

> **将用户的模糊意图，经过高质量产品对话、个性化 UI 设计、强 Worker 自主实现和低成本证据型 QA，持续转化成真正可以发布的软件。**
