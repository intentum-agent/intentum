# intentum

`intentum` is a Pi-native product-building harness. The main Pi session acts as the **Designer**; a deterministic controller owns state, Git worktrees, lifecycle transitions, interruption, recovery, and integration; a separate persistent Pi `AgentSession` acts as the implementation **Worker**.

This repository currently implements the first real vertical milestone from [`intentum.md`](./intentum.md): **Phase 1 plus the single-Worker Phase 2 slice**. The npm package remains `private` while that milestone is hardened and has not been published.

## Current milestone

The implementation is a real **Phase 1 + single-Worker Phase 2 controller slice**, not a set of placeholder modules. The default gate proves the state machine, controller, filesystem/Git boundaries, recovery logic, Pi package loading, and Pi SDK construction. A provider-backed Worker run is a separate live gate and is not represented as passing in this checkout.

## Implemented surface

### Phase 1 — Pi-native skeleton

- local Pi package and extension loading;
- `/intentum init [project name]`;
- atomic `.intentum/state.json` persistence;
- durable charter and architecture artifacts;
- explicit project lifecycle transitions;
- a bounded Designer system-context injection;
- a one-time, responsive terminal welcome sourced from the shipped brand assets;
- a quiet session chrome: a startup card in place of Pi's key hints, a one-line footer, an attention-only widget above the editor, and a mouse-clickable control panel;
- command-only RPC loading and initialization without a provider request.

### Phase 2 — one strong Worker

- one outcome-based `WorkContract` at a time;
- one independent Pi SDK `AgentSession` adapter with persisted session references;
- one branch and one Git worktree outside the target repository;
- Worker-only sandboxed `read`/`edit`/`write`/`bash`, bounded `intentum_git_snapshot`, controller-owned `intentum_commit`, `intentum_progress`, `intentum_escalate`, and `intentum_complete` tools;
- controller-derived result commit and changed-file list;
- safe pause by Pi steering, distinct from explicit emergency abort;
- queued steering while paused or while a pause is pending;
- explicit resume in the same Pi session, or a new recovery session if the old session file is missing;
- restart recovery with attempt identities, same-attempt result reconciliation, full-contract recovery prompts, and durable at-least-once steering;
- explicit, verified `--no-ff` integration with merge-abort on conflicts;
- deterministic rejection of dirty worktrees, moved/swapped Worker identities, pre-existing Git operations, rewritten target ancestry, and Worker changes to `.intentum/**`;
- repository-scoped Controller lease plus cross-process state, contract, result, and integration locks;
- no-follow checks for Controller paths and a fail-closed Worker sandbox preflight.

Phase 3 multi-Worker scheduling, QA sessions, Taste Engine, preview, feature/bug sessions, and shipping automation are intentionally outside this milestone.

## Requirements

- Node.js `>=22.19.0`;
- Git with an existing commit and a named current branch in the target repository;
- Pi `@earendil-works/pi-coding-agent` (the development lock is `0.84.4`);
- Linux with Bubblewrap available at `/usr/bin/bwrap` or `/bin/bwrap`, and a host policy that permits the required user/mount/network namespaces;
- build/test dependencies already reachable from the Worker sandbox's minimal read-only system toolchain or materialized inside the external worktree;
- a Pi-supported model and credential only when actually starting a model-backed Worker.

Pi owns model/provider authentication and session transcripts. Intentum stores only the Pi session reference; it does not copy transcripts into `.intentum/`.

Worker startup is deliberately fail-closed. It does not fall back to unrestricted host `bash`, `edit`, or `write` if Bubblewrap is missing or namespace creation is denied. The current sandbox has no network and does not mount the host home, package-manager stores, the target repository, or the shared Git common directory. Consequently, projects whose dependencies exist only in ignored `node_modules`, a virtualenv, Cargo/Go caches, or a remote registry need a future dependency-provisioning layer before their build can run inside the Worker. This limitation is reported as a live-runtime block, not hidden by the scripted test harness.

## Install

Intentum runs inside [Pi](https://github.com/earendil-works/pi-coding-agent). Install Pi first if you have not:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Then install Intentum as a Pi package. Pi loads it automatically in every session:

```bash
pi install npm:pi-intentum
```

Or install it globally to get the `intentum` command:

```bash
npm install -g pi-intentum
```

Both lines are post-publication instructions. The package is still marked `private` and
has not been published, so for now use the local checkout described under
[Development checkout](#development-checkout).

## Getting started

Run everything from the root of the Git repository you want Intentum to manage. It
needs at least one commit on a named branch.

```bash
cd /path/to/your-repo
intentum doctor            # check Node, Git, Pi, and the Worker sandbox
intentum init My Product   # open Pi and initialize the project
```

`intentum init` opens Pi with Intentum loaded and runs `/intentum init` for you. From
there the Designer conversation takes over. Later sessions just need:

```bash
intentum                   # open Pi with Intentum loaded
intentum status            # print the project phase and Workers without starting Pi
intentum --model sonnet    # anything else is passed straight to pi
```

If you installed Intentum only as a Pi package, the same commands are available inside
Pi as `/intentum init`, `/intentum status`, and so on.

The `intentum` command is a thin launcher. It finds `pi` on your `PATH` (or the Pi
package this package resolves against, or `$INTENTUM_PI`), adds `-e <package>` unless
Pi's settings already register Intentum, starts Pi in its fullscreen (alternate
screen) mode so the session fills the terminal without the shell's earlier output or
scrollback behind it, and hands the terminal to Pi. Pass `--tui-mode regular` to keep
Pi's inline mode instead. On exit Pi prints the transcript back into the terminal by
default; Pi's `fullscreenExitOutput` setting (`/settings` inside Pi) switches that to a
short resume hint. The launcher never talks to a model itself. Pi owns model/provider authentication and session transcripts;
Intentum stores only the Pi session reference and does not copy transcripts into `.intentum/`.

`intentum doctor` reports what will and will not work on this machine. On macOS it
warns that Workers cannot start because the sandbox requires Linux with Bubblewrap.
Designer conversation, `init`, charter, and architecture work everywhere.

## Development checkout

Install the locked development dependencies:

```bash
cd /absolute/path/to/intentum
pnpm install
```

Run the launcher straight from the checkout:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/intentum/bin/intentum.mjs init My Product
```

Or load the checkout into Pi by hand, which is what the launcher does for you:

```bash
cd /absolute/path/to/target-repository
pi -e /absolute/path/to/intentum
```

Then type `/intentum init My Product` inside Pi.

The first successful initialization renders the responsive terminal lockup once,
adjacent to the editor rather than in the scrolling transcript. Running `/intentum`
without arguments in an uninitialized repository shows the same one-time welcome.
Session restore, status output, Worker cards, and later commands use only the compact
`⋗ intentum` identity.

### Session chrome, attention widget, and control panel

In Pi's terminal mode Intentum replaces Pi's startup key hints with a small card (logo,
`intentum vX.Y.Z`, model and thinking level, working directory) and Pi's three-line footer
with one line: `⋗ intentum · <project> · build 4/8 · balanced` on the left, plus a worker
count, `⚠ n`, or `◆ decision` only when they apply, and the Git branch and context usage on
the right. Above the editor nothing is shown while the project is idle; the widget appears
only for a completed result awaiting integration, a blocked or failed Worker, or a blocking
decision. Everything else lives in the control panel.

Pi's own `[Skills]`, `[Prompts]`, and `[Extensions]` listing is printed by Pi, not by
Intentum; set `"quietStartup": true` in `~/.pi/agent/settings.json` (or the project's
`.pi/settings.json`) to hide it.

`/intentum` with no arguments opens the control panel as an overlay with four tabs:
Overview (next step, phase trail, decision and worker highlights, project actions),
Workers (one row per Worker with status-appropriate buttons such as Steer, Pause,
Resume, Integrate, Abort, and Details), Decisions (options, the Designer's
recommendation, affected work), and Help. The panel updates live while it is open.

Every control works with the keyboard (`↑↓`/`j`/`k` move, `⏎` acts, `tab` or `1`-`4`
switch tabs, `p` pauses or resumes, `esc` closes). In Pi's fullscreen mode, which the
`intentum` launcher uses by default, the viewport owns the mouse, so the panel is
keyboard-only there. In Pi's regular terminal mode (`intentum --tui-mode regular`, or
plain `pi`) the panel also takes the mouse: click a tab, a row, or a `[button]`, scroll
with the wheel, and click outside the panel to close it. Mouse reporting is enabled
only while the panel is open, so native selection and scrollback return as soon as it
closes.
Choosing a decision in the panel drafts the message into the editor; you still send
it to the Designer yourself.

The target repository must already have `HEAD`; Intentum refuses to create a Worker from an unborn branch. Review project-local package resources before trusting a project in Pi.

## Interaction model

Normal conversation remains the primary interface. The Designer inspects the existing repository, drafts charter and architecture from that evidence, identifies the most important residual uncertainty, and asks at most one important product question at a time — usually to confirm a draft, not to start from scratch. Deterministic operations are delegated to Intentum tools rather than simulated in the Designer chat.

Typical flow:

1. Run `intentum init [name]`, or `/intentum init` inside Pi.
2. Confirm the repo-derived charter and approved architecture direction.
3. The Designer submits one broad `intentum_create_work` contract.
4. The controller creates `intentum/F-001/W-001` in an external worktree.
5. The Worker inspects, implements, tests, commits, and submits a structured result.
6. The controller independently verifies the branch, clean worktree, ancestry, protected paths, result commit, and actual diff.
7. The Human or Designer explicitly invokes integration.

## Commands

| Command | Effect |
| --- | --- |
| `/intentum` | Open the control panel (overview, workers, decisions, help). Text help in RPC mode. |
| `/intentum init [name]` | Idempotently initialize state and product artifacts. |
| `/intentum status` | Show the current phase, autonomy, active feature, Worker, and decision summary as text. |
| `/intentum workers` | Open the panel on the Workers tab; list Worker state as text in RPC mode. |
| `/intentum decisions` | Open the panel on the Decisions tab; list pending decisions as text in RPC mode. |
| `/intentum pause` | Pause project scheduling and steer a live Worker toward a safe boundary. |
| `/intentum resume` | Resume project scheduling in the phase that preceded the pause. |
| `/intentum steer W-001 message` | Send an instruction now, or queue it while paused/interrupted/blocked. |
| `/intentum worker-resume W-001 [message]` | Explicitly resume the preserved Worker or create a recovery session. |
| `/intentum integrate W-001` | Verify and merge a completed Worker result. Guided mode asks for confirmation. |
| `/intentum abort W-001 reason` | Explicit emergency abort; preserve session, branch, worktree, and files. |

## Terminal brand and companion command

Terminal artwork is loaded directly from [`brand/ascii`](./brand/ascii); neither the
extension nor the launcher carries a second hand-drawn copy. The renderer
measures the checked-in assets and selects a layout from `process.stdout.columns`:

| Available columns | Layout |
| --- | --- |
| `>= 113` | `banner-big.txt` |
| `58–112` | `banner-small.txt` |
| `21–57` | `logo-small.txt` with a plain `intentum` label |
| `12–20` | `logo-small.txt` without a wordmark |
| `< 12` | compact `⋗ intentum`, clipped only when the terminal is narrower than the label |

An unknown width is treated as 80 columns. Only the `o`/`@` Signal point cells are
colored; the arms and wordmark keep the terminal's default foreground. Set
`INTENTUM_ASCII_MARK=1` when the terminal font does not contain `⋗`; the compact mark
then uses `>•`.

`intentum --help` and `intentum --version` show the lockup. `pi-intentum` is the
historical companion name and runs the same executable.

## Registered tools

Designer surface:

- `intentum_project` — status, charter/architecture reads and writes, lifecycle transition;
- `intentum_create_work` — create and start the single broad WorkContract;
- `intentum_worker` — inspect, pause, steer, resume, or explicitly abort the Worker;
- `intentum_integrate` — verify and merge a completed result.

Worker surface:

- `read`, `edit`, `write`, `bash` — Pi-compatible operations confined to the canonical Worker worktree; `bash` runs in the Bubblewrap namespace;
- `intentum_git_snapshot` — bounded branch/HEAD/status/diff/log facts without exposing shared Git configuration;
- `intentum_commit` — host-side, identity-checked commit creation with hooks and signing disabled;
- `intentum_progress` — record meaningful progress or acknowledge a requested safe pause;
- `intentum_escalate` — stop at a safe boundary and report a blocker/decision;
- `intentum_complete` — submit a factual structured result.

The Worker resource loader uses `noExtensions: true`, which prevents recursive loading of the Intentum controller inside the Worker worktree. Project context files and skills remain available; the Worker gets a bounded charter/architecture snapshot plus the complete WorkContract.

## Durable project data

```text
.intentum/
├── state.json
├── activity.jsonl
├── charter.md
├── architecture.md
├── features/
│   └── F-001/
│       └── work.json
└── runs/
    └── W-001/
        └── result.json
```

Writes to JSON state/results/contracts use a unique temporary sibling followed by `rename`. Repository-scoped file locks serialize mutations across Store instances and OS processes, while a long-lived Controller lease prevents two live Pi sessions from recovering or controlling the same repository. Every Controller-owned directory component is checked without following symlinks before locks or artifacts are created. The files may be version-controlled; controller-authored `.intentum/**` changes are excluded from target-worktree cleanliness checks, while Worker commits touching those paths are rejected.

Worker worktrees live at:

```text
${XDG_CACHE_HOME:-~/.cache}/intentum/<project-id>/worktrees/<worker-id>/
```

The path is canonicalized and checked so a symlink cannot place it inside the target repository.

## Pause, abort, and recovery semantics

- **Safe pause** sets the project scheduler to paused and calls `session.steer()` with a safe-boundary instruction. `intentum_progress({ state: "paused" })` records terminal pause intent; the Controller publishes `paused` only after that agent turn settles, so a mixed tool batch cannot finalize the state early.
- **Steering** is written to a durable outbox before it is sent to Pi. Instructions included in a resumed prompt are acknowledged only after that turn settles; late live steering remains available for at-least-once recovery rather than being silently lost in Pi's queue/settled race.
- **Emergency abort** first persists `interrupted`, then calls `session.abort()`. Late Worker callbacks cannot overwrite interrupted or terminal state.
- **Process restart** reconciles a same-attempt durable terminal result when possible; otherwise it converts active recoverable records to `interrupted`, abandons unrecoverable reservations, reports preserved attention items, and deletes neither valid worktree nor session.
- **Missing prior session** causes explicit resume to create a new Pi recovery session in the preserved worktree. A missing worktree stops resume with a precise diagnostic.
- **Session recovery** always sends the complete immutable WorkContract plus bounded approved charter/architecture snapshots, so a crash before the first Pi transcript flush cannot remove the implementation contract.

## Validation

Run the complete local gate:

```bash
cd /absolute/path/to/intentum
pnpm check
```

That gate runs:

```text
TypeScript strict typecheck
Vitest unit and real-Git integration tests
actual Pi package-directory RPC load/init/status/widget/banner smoke
real npm tarball creation, required-file assertions, offline temporary install,
and execution of the installed `intentum` and `pi-intentum` shims
```

The RPC smoke uses a disposable Git repository, isolated Pi config directory, `PI_OFFLINE=1`, and `PI_TELEMETRY=0`. It verifies extension/package discovery, `/intentum init`, `/intentum status`, state/artifact creation, widget/status events, and the absence of an agent/model start.
It also verifies that initialization emits serializable welcome lines and that the
subsequent restored status session does not replay them.

See [`docs/IMPLEMENTATION_STATUS.md`](./docs/IMPLEMENTATION_STATUS.md) for the current evidence boundary.

## Evidence boundaries

Default local checks establish controller, storage, real disposable Git behavior, recovery, adapter construction, package loading, and command-only behavior. They do **not** establish:

- successful Bubblewrap execution on a host whose namespace policy rejects the sandbox preflight;
- dependency installation or a representative build inside the current networkless/minimal Worker sandbox;
- a provider-backed Worker completing a real repository task;
- live streaming pause/steer timing against every provider;
- propagation of one-off CLI `--api-key` overrides into a separately-created SDK runtime;
- inheritance of dynamically registered third-party providers;
- visual acceptance of the interactive TUI.

Those remain explicit live/manual gates rather than being represented by fake credentials or a fake provider.

## Upstream references

- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi RPC mode](https://pi.dev/docs/latest/rpc)
- [Pi package migration announcement](https://pi.dev/news/2026/5/7/pi-has-a-new-home)

## License

MIT
