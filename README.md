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
- a quiet session chrome: a startup card in place of Pi's key hints, a one-line footer, an attention-only widget above the editor, and a keyboard-first command center with regular-mode mouse support;
- a transcript in the Oh My Pi idiom: every tool call is one rounded, state-colored frame with a status header, and the working row becomes a breathing "thinking" pulse with a tok/s badge while the Designer reasons;
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
- deterministic rejection of dirty worktrees, moved/swapped Worker identities, pre-existing Git operations, rewritten target ancestry, and Worker changes to `.intentum/**` or `.pi/**`;
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

The project name for `init` ends at the first option, so `intentum init My Product
--model sonnet` names the project "My Product" and passes `--model sonnet` to Pi.

`intentum init` opens Pi with Intentum loaded and runs `/intentum init` for you. From
there the Designer conversation takes over. Later sessions just need:

```bash
intentum                   # open Pi with Intentum loaded
intentum status            # print next steps, attention, work, and project details without starting Pi
intentum --model sonnet    # anything else is passed straight to pi
```

If you installed Intentum only as a Pi package, `init` and `status` are available
inside Pi as `/init` and `/status` (or `/intentum init` and `/intentum status`).
`doctor` is launcher-only: it reports on the machine before Pi starts.

The `intentum` command is a thin launcher. It finds `pi` on your `PATH` (or the Pi
package this package resolves against, or `$INTENTUM_PI`), adds `-e <package>` unless
Pi's settings already register Intentum, starts Pi in its fullscreen (alternate
screen) mode so the session fills the terminal without the shell's earlier output or
scrollback behind it, and hands the terminal to Pi. Pass `--tui-mode regular` to keep
Pi's inline mode instead. On exit Pi prints the transcript back into the terminal by
default; Pi's `fullscreenExitOutput` setting (`/settings` inside Pi) switches that to a
short resume hint. The launcher never talks to a model itself. Pi owns model/provider authentication and session transcripts;
Intentum stores only the Pi session reference and does not copy transcripts into `.intentum/`.

In fullscreen mode, click within the prompt text to move the editing cursor there.
Positioning follows wrapped and multiline text, including Chinese and emoji; clicking
past the text moves to the end of that displayed line. Transcript mouse controls and
overlay controls remain available outside the prompt.

`intentum status` is deliberately plain text with no ANSI styling. It leads with the
next step, then work needing attention, current work, and project details; repository
text stays on one line without truncating CJK text or emoji.

`intentum doctor` reports what will and will not work on this machine. On macOS it
warns that Workers cannot start because the sandbox requires Linux with Bubblewrap.
Designer conversation, `init`, charter, and architecture work everywhere.

`intentum fonts install` downloads Symbols Nerd Font Mono (pinned release, checksum
verified) into your user font directory — `~/Library/Fonts` on macOS,
`$XDG_DATA_HOME/fonts` (default `~/.local/share/fonts`, then `fc-cache`) on Linux — so
the status line can use the same icons as Oh My Pi. It never runs during `npm install`:
package managers block lifecycle scripts, and a font download that writes into your
home directory should be a command you ran on purpose. `intentum fonts` shows whether a
Nerd Font is installed; `doctor` reports the same line. Configure your terminal to use
it as a fallback, then set `INTENTUM_SYMBOLS=nerd` to enable icons.

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

Then type `/init My Product` inside Pi.

The first successful initialization renders the responsive terminal lockup once,
adjacent to the editor rather than in the scrolling transcript. Running `/intentum`
without arguments in an uninitialized repository shows the same one-time welcome.
Session restore, status output, Worker cards, and later commands use only the compact
`⋗ intentum` identity. The mark follows the glyph preset: with a Nerd Font it is the
bullseye-arrow icon (`U+F08C9`), otherwise `⋗`, and `>•` under `INTENTUM_SYMBOLS=ascii`.

### Session chrome, attention widget, and control panel

In Pi's terminal mode Intentum replaces Pi's startup key hints with a welcome card: a
framed box titled `intentum vX.Y.Z` with the logo, greeting, model and provider on the
left and three sections on the right — state-aware tips (`/init` before a project exists,
`/panel`, `/status`, `/steer`, `/help` after), the project line (name, phase, autonomy,
worker and decision counts, working directory), and the three newest sessions started in
this directory with their age. One rotating tip sits under the card. Terminals narrower
than about 60 columns get the three facts as plain lines instead; `INTENTUM_SYMBOLS=ascii`
draws the frame with `+-|` rather than box-drawing glyphs.

Pi's three-line footer becomes one status line of icon-led segments joined by `·`, in the
shape of a modern coding-agent status bar. Left: `⋗ <project>`, host, model and thinking
level, working directory (an OSC 8 link the terminal can open, clipped from the front),
Git branch with `*unstaged +staged ?untracked` counts, session id, then Intentum's own
facts — `⚑ BUILD 4/8`, `◆ n decisions`, `⚠ n attention`, `● n active`, `✓ n review`,
`○ n paused`, `⚙ <autonomy>` — and any status other extensions publish. Right: tokens in,
tokens out, session cost, context usage (`6.1%/272K`, coloured by pressure) and the
context window. Phase, blocking decisions, and exceptional work always survive a narrow
terminal; every other segment yields by priority (host and context total first, Git and
context pressure last) until the line fits. Working-tree counts come from `git status`,
refreshed at most every three seconds while the footer repaints.

`INTENTUM_SYMBOLS` selects the glyph set: `nerd` (Nerd Font icons, the same code points
Oh My Pi's status line uses), `unicode` (single-cell glyphs any modern font carries), or
`ascii` (`in:`, `out:`, `ctx:`, `@` branch, `>•` mark; also plain box rules in the
welcome card). When it is unset Intentum picks `nerd` for terminals that bundle the
symbols (Ghostty, WezTerm), and `unicode` otherwise. Finding an installed Nerd Font
does not confirm the current terminal uses it for fallback. For other terminals,
configure a Nerd Font and set `INTENTUM_SYMBOLS=nerd`, or keep the ordinary symbols
with `INTENTUM_SYMBOLS=unicode`. The launcher explains this once per start until the
variable is set.

Above the editor nothing is shown while the project is idle; the widget appears only for
a completed result awaiting integration, a blocked or failed Worker, or a blocking
decision. Everything else lives in the control panel.

Pi's own `[Skills]`, `[Prompts]`, and `[Extensions]` listing is printed by Pi, not by
Intentum; set `"quietStartup": true` in `~/.pi/agent/settings.json` (or the project's
`.pi/settings.json`) to hide it.

`/intentum` with no arguments opens a temporary command center with four tabs:
Overview (next step, attention/results, active work, project context), Workers,
Decisions, and Help. Fullscreen mode fills the viewport so transcript text cannot
bleed around the surface; terminals at least 100×22 use a two-column workspace and
terminals at least 60×16 use a compact single column. Smaller terminals receive a
plain status summary and the relevant slash commands instead of clipped controls.

Worker details load only when requested. They lead with the outcome, user-visible
changes, test evidence, remaining risks, and follow-ups; branch, worktree, session,
and commit metadata stay secondary. Paused work is neutral, blocked work is a
warning, failures are errors, and completed work is explicitly ready for review.

Every control is a full-width keyboard option (`↑↓`/`j`/`k` move, `⏎` acts, `tab` or
`1`-`4` switch tabs, `p` pauses or resumes, `esc` closes). In Pi's fullscreen mode,
which the `intentum` launcher uses by default, the viewport owns the mouse, so the
command center is deliberately keyboard-first. In regular mode (`intentum --tui-mode
regular`, or plain `pi`) the centred panel also takes the mouse: click anywhere on an
option row, scroll with the wheel, and click outside to close it. Mouse reporting is
enabled only while the panel is open.

Designer streaming, Worker activity, and panel actions use restrained pulse/spinner
feedback. Set `INTENTUM_REDUCED_MOTION=1` to keep the same state labels with static
glyphs.
Choosing a decision in the panel drafts the message into the editor; you still send
it to the Designer yourself.

### Transcript: tool frames and the thinking pulse

Tool activity renders the way Oh My Pi draws it. Every call — Pi's built-in `read`,
`bash`, `edit`, `write`, `grep`, `find`, `ls` and the `intentum_*` Designer tools — is
one rounded frame whose border follows the call's state: accent while pending or
running, dim once it succeeded, red on error, yellow when a command was aborted or
timed out. The header line carries a status glyph (`○` pending, a braille spinner
while running, `✔`/`✘` settled), the tool title, its subject, and dim meta such as
`2 matches · limit 2 reached`. Bodies come from the arguments while the call streams
(the command, the file being written, the diff previewed against disk) and gain a
labeled `Output` section when the result lands, so the block never jumps. Collapsed
previews keep the live edge behind `… N earlier lines [ctrl+o: Expand]`; the key in
the hint follows your Pi keybinding. All live spinners share one 80 ms ticker and
advance in lockstep.

Behavior is untouched: the built-in overrides spread Pi's own tool definitions and
replace only `renderCall`/`renderResult`, so `execute`, schemas, and prompt snippets
stay Pi's. They register at `session_start` because the frames need the session cwd.

While the Designer reasons, the working row under the transcript turns into the
thinking pulse: a fixed-width starburst (`✻ ✼ ❉ ❊ ✺ ✹ ✸ ✶`) breathing on an eased
70–230 ms cadence, beside `Thinking · 1.2K · 45.3 toks/s` once the provider streams
reasoning tokens — the rate badge fades from dim gray toward the accent as speed
climbs, and the count and rate self-suppress for providers that only report usage at
turn end. The row returns to the `Designer working` indicator as soon as text or a
tool call starts. A hidden thinking block in the transcript shows `✻ Thinking`;
visible thinking is folded to prose (fenced code becomes `…`, empty `<!-- -->`
reasoning-summary markers disappear). `INTENTUM_SYMBOLS=ascii` swaps the frame,
spinner, and pulse glyphs for `+-|`, `|/-\`, and `*+x+`; `INTENTUM_REDUCED_MOTION=1`
freezes the pulse on its first facet.

The target repository must already have `HEAD`; Intentum refuses to create a Worker from an unborn branch. Review project-local package resources before trusting a project in Pi.

## Interaction model

The Designer model picker uses Intentum's quiet rounded frame and theme colors,
occupying 94% of the terminal width and 90% of its height, with more visible rows
as the terminal grows.
Wide terminals show providers, models, and details side by side; narrow terminals
use Ctrl+P to open the provider list and stack model details below the models.
It highlights the current model and previews context/output limits, reasoning,
image support, and catalog token prices. The full Pi provider catalogue stays
visible, with ready providers first and unconnected providers marked `○`.
Choose an unconnected provider or model with Enter to open Pi's native login flow;
the picker reopens afterwards and preserves the editor draft. Multiple provider
connections coexist. Available models and `--models` scopes come from Pi;
out-of-scope models are browsable but cannot be applied. Switching is
available between turns. `/model <reference>` keeps Pi's direct selection and
thinking-suffix behavior; `/models <search>` opens a filtered picker.

Mouse controls work in regular and fullscreen mode: click a provider to filter,
click a model to preview, scroll either list, then click **Use model** or **Connect**
to apply. Click a provider's star or **Pin provider** button (or press Ctrl+F)
to keep that provider at the top of the provider list. Pins are stored in
`~/.pi/agent/intentum/provider-pins.json` (respecting `PI_CODING_AGENT_DIR`);
on first use, up to three pins are seeded from the current provider and this
session's most frequently selected providers. Unpinning is persistent, and
pinning a provider leaves the current model and model-list order unchanged.
Close with the top-right × or Esc. Mouse capture ends when the picker closes.

Normal conversation remains the primary interface. The Designer inspects the existing repository, drafts charter and architecture from that evidence, identifies the most important residual uncertainty, and asks at most one important product question at a time — usually to confirm a draft, not to start from scratch. Deterministic operations are delegated to Intentum tools rather than simulated in the Designer chat.

Typical flow:

1. Run `intentum init [name]`, or `/init` inside Pi.
2. Confirm the repo-derived charter and approved architecture direction.
3. The Designer submits one broad `intentum_create_work` contract.
4. The controller creates a new branch such as `intentum/F-001/W-001` from the current committed `HEAD` in an external worktree. Staged, unstaged, and untracked changes in the target directory stay in place and do not block Worker startup; they are not copied into the Worker. Commit any changes the task depends on before starting it.
5. The Worker inspects, implements, tests, commits, and submits a structured result.
6. The controller independently verifies the branch, clean worktree, ancestry, protected paths, result commit, and actual diff.
7. The Human or Designer explicitly invokes integration, which still requires the target worktree to be clean apart from controller-owned state.

## Commands

Every action is a top-level slash command. The long form `/intentum <action>` still works
and is the only way to reach `resume`, because Pi's built-in `/resume` (session picker)
takes precedence over extension commands.

| Command | Effect |
| --- | --- |
| `/intentum` or `/panel` | Open the control panel (overview, workers, decisions, help). Text help in RPC mode. |
| `/models [search]` or `/model` | Open the Designer model picker: type to search, Ctrl+P to browse all providers, ↑/↓ or PgUp/PgDn to browse, Tab/Shift+Tab to cycle providers, Enter to choose or connect, Esc to go back or cancel. The configured Pi model-selection shortcut opens it too. |
| `/help` | Show the commands relevant to the current project state. |
| `/init [name]` | Idempotently initialize state and product artifacts. |
| `/status` | Show the current phase, autonomy, active feature, Worker, and decision summary as text. |
| `/workers` | Open the panel on the Workers tab; list Worker state as text in RPC mode. |
| `/decisions` | Open the panel on the Decisions tab; list pending decisions as text in RPC mode. |
| `/pause` | Pause project scheduling and steer a live Worker toward a safe boundary. |
| `/intentum resume` | Resume project scheduling in the phase that preceded the pause. |
| `/steer W-001 message` | Send an instruction now, or queue it while paused/interrupted/blocked. |
| `/worker-resume W-001 [message]` | Explicitly resume the preserved Worker or create a recovery session. |
| `/integrate W-001` | Verify and merge a completed Worker result. Guided mode asks for confirmation. |
| `/abort W-001 reason` | Explicit emergency abort; preserve session, branch, worktree, and files. |

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
colored; the arms and wordmark keep the terminal's default foreground. The compact
mark is the Nerd Font icon when the terminal bundles it or `INTENTUM_SYMBOLS=nerd` is set, `⋗`
under `unicode`, and `>•` under `ascii` for fonts that render neither.

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

Writes to JSON state/results/contracts use a unique temporary sibling followed by `rename`. Repository-scoped file locks serialize mutations across Store instances and OS processes, while a long-lived Controller lease prevents two live Pi sessions from recovering or controlling the same repository. Every Controller-owned directory component is checked without following symlinks before locks or artifacts are created. The files may be version-controlled; controller-authored `.intentum/**` changes are excluded from target-worktree cleanliness checks, while Worker commits touching those paths are rejected. `.pi/**` is protected the same way: a Worker-authored Pi extension or settings file would otherwise run as host code in the next project-trusted session.

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

MIT. The session status line is derived from [Oh My Pi](https://github.com/can1357/oh-my-pi)
(MIT, © Mario Zechner, Can Bölük, Stencil Labs, Inc.); its notice is reproduced in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
