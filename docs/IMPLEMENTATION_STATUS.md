# Intentum 实现状态

更新时间：2026-09-03

## 结论

当前仓库已落地设计文档的 **Phase 1 + Phase 2 单 Worker vertical slice**。这是一条可执行的 Controller/Git/Pi SDK 路径，而不是后续章节的空壳：Pi extension、持久状态、Designer 上下文、WorkContract、外部 worktree、Worker lifecycle、结构化结果、恢复和显式集成都有代码与自动化测试。

证据边界必须同时保留：默认门禁使用 scripted Worker 验证 Controller 和真实 Git，并使用实际 Pi 0.84.4 验证 package/RPC 与 SDK 构造；当前容器不允许 Bubblewrap 所需 namespace，因此 **真实 sandboxed、provider-backed Worker E2E 仍为 EXPECTED_BLOCK / NOT_PROVEN**。Phase 3 以后的多 Worker Scheduler、独立 QA、Taste Engine、preview、feature/bug/ship sessions 尚未实施。

## 2026-09-03 远端设计增量

本地 `main` 已从 `06f0c72` 快进到 `0ff932d`，纳入：

- `c3cc5b7 feat(brand): add logo assets, ascii banners, and banner spec`；
- `0ff932d fix(brand): align lockup mark to baseline`。

新版 `intentum.md` 的新增行为集中在 §15.2 Banner 与 Logo；现有 Worker、Git、状态、恢复和安全模型没有发生语义变化。品牌资产位于 `brand/`，本轮已完成以下适配：

1. `/intentum init` 首次成功后的单次响应式 Banner；
2. 未初始化项目执行无参数 `/intentum` 时的欢迎 Banner；
3. 按终端宽度选择 big/small/logo-only/`⋗ intentum` fallback；
4. 只给 mark point 使用 Signal red，wordmark 保持默认前景色；
5. session chrome：TUI 模式下用品牌卡片替换 Pi 启动提示、单行 `⋗ intentum` footer，编辑器上方只显示需要处理的事项；
6. `intentum` 启动器（`init`/`status`/`doctor`/透传 Pi 参数）以及 `--help`/`--version`；`pi-intentum` 为同一可执行文件的历史别名；
7. 将 `brand/` 纳入 npm `files` 和 pack manifest，并增加资产、宽度、一次性显示和 RPC 回归测试。

实现时还发现远端文档的宽度数据与已提交资产相差一列：`text-small.txt` 实测最大 44 列，`banner-small.txt` 实测最大 58 列。文档与选择边界已同步为 58 列起用 small banner；21–57 列使用 compact mark + wordmark；12–20 列保留 small mark。这样所有已选择的原始行都不超过可用列数。

因此，远端更新前的 Phase 1/2 Controller 门禁与新增品牌/TUI delta 均已进入当前工作树门禁。`intentum` 只是一个启动器：定位 `pi`、在 Pi settings 未注册本包时追加 `-e <package>`、把 `intentum init <name>` 转成初始 `/intentum init` 命令；它不建立第二套 agent runtime，也不调用 provider。

## 已实现的核心路径

1. Pi package/extension 注册 `/intentum`、Designer tools、session lifecycle hook、Designer system context 与状态 widget。
2. `.intentum/state.json`、charter、architecture、WorkContract、activity log、attempt-scoped Worker result 的持久化。
3. unique sibling temp + rename 原子替换；同进程队列、跨进程 file lock 与长期 Controller lease。
4. `.intentum`、feature/run/result/lock 路径逐组件 no-follow 校验，拒绝符号链接把 Controller 写操作导向仓库外。
5. 单个 unfinished Worker；外部 canonical Git worktree；`intentum/<feature>/<worker>` 分支；target 在显式 integrate 前不变。
6. 完整 outcome-based WorkContract、approved charter/architecture snapshot 和恢复包传递。
7. 独立 Pi `AgentSession`，使用 `customTools` 注册工具、`tools` 作为名称 allowlist，并用 `noExtensions: true` 阻止递归加载 Controller。
8. Worker `read/edit/write/bash` 的 Bubblewrap 边界、受限 Git snapshot、Controller-owned commit、progress/escalate/complete 工具。
9. 安全 pause、durable at-least-once steer、resume、missing/corrupt session recovery 与显式 emergency abort。
10. result attempt identity、terminal first-wins、`agent_settled` 最终验证、provider final-error 保留、terminal runtime 释放。
11. Controller 从 Git 独立取得 result commit/changed files，并复验 worktree registration、common-dir、branch、base ancestry、cleanliness 与 protected paths。
12. 显式 `--no-ff` merge；target branch/base/head/Git-operation 前置校验；真实冲突自动 abort；幂等 crash reconciliation；integration 在 runtime dispose 前被 cancel/drain。
13. 从 `brand/ascii/` 读取的响应式、一次性欢迎 Banner；Pi TUI 每行 `Text` 渲染；Signal point 精确着色；RPC 使用可序列化行且 restore 不重放。
14. `intentum` 启动器（launch/init/status/doctor，见 `tests/cli-launcher.test.ts`）、`--help/--version`、品牌资源发布白名单、真实 tarball 离线安装与已安装 `intentum`/`pi-intentum` bin 执行门禁。
15. 统一 `HarnessPresentationModel`、主题感知 attention widget、优先级 footer，以及 `/intentum` command center（Overview/Workers/Decisions/Help）。Fullscreen 临时覆盖 viewport：≥100×22 双栏、≥60×16 单栏，更小尺寸降级为纯文本状态；regular 模式使用居中面板与整行 SGR 鼠标命中。面板具备视口安全焦点、操作中/成功/错误反馈、reduced-motion、懒加载且证据优先的 Worker details；决策仍只草拟到 editor。见 `src/tui/presentation.ts`、`src/tui/control-panel.ts`、`src/tools/control-panel-host.ts`。

## 关键不变量

- `blocked`、`paused`、`interrupted` 都占用单 Worker 槽位；只有 terminal/abandoned record 释放槽位。
- Project pause 不等于 emergency abort；安全暂停必须由 Worker 在原子边界确认。
- Worker 不能合并 target、直接改共享 Git metadata，或把 `.intentum/**` 纳入结果。
- result commit、diff、状态与 identity 不相信模型输入，全部由 Controller 验证。
- terminal tool intent 在 Pi mixed batch 后仍由 settled verification 收敛；晚到 callback、旧 generation/turn/attempt 不得覆盖新运行。
- steering 在调用 Pi 前先持久化；晚到 steering 不因当前 turn 的 settled 被误删。
- 同一仓库只允许一个 live Controller owner；第二个 Pi session 不能 recovery、resume、abort 或 integrate owner 的 Worker。
- lifecycle dispose 在释放 Controller lease 前 cancel/drain integration 和可取消 provisioning；late runtime construction 只能被释放，不能重新 attach。
- activity log 与 TUI 是非 canonical observer；写日志或渲染异常不得阻断 pause/abort/state transition。

## 默认本地门禁

执行：

```bash
cd /absolute/path/to/intentum
pnpm check
pnpm exec pi --version
```

`pnpm check` 串行运行：

1. TypeScript strict typecheck；
2. Vitest unit + real filesystem/Git integration；
3. actual Pi CLI package-directory RPC `init/status/widget/banner` smoke；
4. 真实 npm tarball、发布物清单、离线临时安装与已安装 CLI smoke。

最终数字以本文件“最终验证记录”为准；每次代码修改后重新运行门禁，不从旧日志推断 PASS。

## 测试覆盖

- schema、state transition、contract/result validation、extra-property 污染与手工 artifact 污染；
- atomic write、串行 update、两个 Store/进程 file lock、stale owner recovery；
- `.intentum`/runs symlink 越界、cache/worktree identity swap、unregistered/replaced worktree；
- create → real external worktree → commit → complete → settled verify → explicit merge；
- dirty/uncommitted/moved branch/rewritten target/pre-existing Git operation/merge conflict；
- tracked `.intentum` 不自阻塞，Worker `.intentum` change 被拒绝；
- pause、pause delivery retry、queued steer、late steer outbox、resume、abort、abort failure/overlap；
- concurrent/delayed create/restore/resume、lifecycle generation、old callback、terminal mixed batch、integration dispose cancellation；
- result/state crash split、attempt-scoped reconciliation、missing/corrupt session、missing/wrong worktree、repeated restart attention summary；
- untrusted project拒绝 Worker、session cwd mismatch、第二 live Controller ownership拒绝；
- sandbox command layout、trusted executable paths、no root/home mount、symlink/EPIPE/abort process-group、Git-config credential boundary；
- Pi SDK construction/restore without model invocation、final provider error mapping、actual RPC extension loading；
- 品牌资产宽度/纯 ASCII/无 ANSI、point-only 颜色 mask、一次性 TUI/RPC 欢迎生命周期；
- companion CLI 宽度边界/help/version、真实 tarball required files、离线安装后 bin 执行。

## Sandbox 与 live gate

真实 Worker 默认调用 `/usr/bin/bwrap` 或 `/bin/bwrap`，并要求 preflight 成功。它使用私有 network/PID namespace、临时 HOME、clean environment、canonical worktree 作为唯一持久可写 bind，不挂载 host HOME、shared Git common-dir 或 target repository。若宿主策略禁止 namespace，创建 Worker 会在暴露 `working` session 前 fail closed。

当前容器的实际结果是：Bubblewrap 二进制存在，但 namespace preflight 返回 `Operation not permitted`。此外，当前 sandbox 不提供网络和 host package caches；外部 Git worktree 也不会复制 ignored `node_modules`/virtualenv。因此代表性项目 build/test 还需要受控 dependency/toolchain provisioning 或另一种同等隔离 backend。

这意味着：

| 能力 | 当前证据 |
| --- | --- |
| Controller/state/real-Git/recovery | 自动化 PASS |
| Pi package/RPC command path | actual Pi 0.84.4 PASS，init/status/widget/banner；`modelInvoked=false` |
| Pi child session construction seam | PASS，不调用 provider |
| 当前主机真实 Bubblewrap Worker startup | EXPECTED_BLOCK（namespace policy） |
| sandbox 内代表性依赖 build/test | NOT_PROVEN |
| provider-backed Worker 完成真实任务 | NOT_PROVEN |
| live streaming pause/steer timing | NOT_PROVEN |
| interactive TUI component rendering | PASS：unit 覆盖 30×12/40×12 fallback、60×16/80×24 compact、120×40 wide、CJK/emoji、焦点/滚动、action/detail state；真实 Pi 0.84.4 PTY 已验收 fullscreen 80×24/120×40 全屏覆盖、40×12 文本降级、嵌套 confirm 可见与 regular 80×24/mouse-report lifecycle；launcher-selected Pi 0.85.0 fullscreen 80×24 兼容通过 |
| one-off `--api-key` 继承到 child runtime | NOT_PROVEN |
| 动态注册第三方 provider 继承 | NOT_PROVEN |

## 版本与 API 边界

- Node.js：`>=22.19.0`；
- 开发锁：`@earendil-works/pi-coding-agent@0.84.4`、`@earendil-works/pi-ai@0.84.4`、`@earendil-works/pi-tui@0.84.4`、`typebox@1.3.7`；
- Pi 核心包在 runtime manifest 中使用 peer dependencies，避免把第二套 Pi runtime 打入扩展；
- TypeBox 从 `typebox` 导入；Google-compatible enums 使用 Pi AI `StringEnum`；
- 以本地锁定版本 typecheck/test 为准，不把未来 main 分支 API 假定为 0.84.4。

## 最终验证记录

2026-09-03 本轮最终串行门禁：

```text
pnpm typecheck: PASS
pnpm test: PASS — 16 files / 125 tests
pnpm smoke:rpc: PASS — Pi 0.84.4; init/status/widget/banner PASS; modelInvoked=false
pnpm pack:check: PASS — 72 entries; all source brand files present; requiredFiles/temporaryInstall/installedCli=PASS
intentum --help/--version and pi-intentum --version: PASS from the installed tarball
pnpm exec pi --version: 0.84.4
```

当前主机的真实 sandbox capability probe：

```text
BWRAP_PREFLIGHT_EXIT=1
bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted
```

因此默认门禁整体 PASS；真实 sandboxed/model-backed Worker gate 保持 `EXPECTED_BLOCK / NOT_PROVEN`，没有把 construction-only SDK 或 scripted Worker 测试外推为 live provider 成功。
