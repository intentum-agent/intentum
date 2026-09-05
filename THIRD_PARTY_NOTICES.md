# Third-party notices

Intentum is released under the MIT License (see [`LICENSE`](./LICENSE)). The
components below are derived from other MIT-licensed software; their copyright and
permission notices are reproduced here as that license requires.

## Oh My Pi

The session status line in `src/tui/session-chrome.ts` — icon-led segments joined by
`·`, essential facts kept while lower-priority segments yield, host/model/cwd/Git/session
facts on the left and token, cost, and context usage on the right — is derived from the
status line of Oh My Pi, <https://github.com/can1357/oh-my-pi>.

The model picker in `src/tui/model-picker.ts` takes interaction inspiration from
Oh My Pi's `modes/components/model-picker.ts`, `model-browser.ts`, and `model-hub.ts`:
searchable model rows, a current-model marker, selection details, and a provider
catalogue with native login entry points. Intentum implements
its own responsive layout, provider filters, and Pi extension adapter.

The transcript rendering is derived from the same project: the rounded state-colored
tool frame, status header, collapsed-preview and JSON-tree conventions in
`src/tui/tool-frame.ts` (from `tui/output-block.ts`, `tui/status-line.ts`,
`tools/render-utils.ts`, `tools/json-tree.ts`, `tools/default-renderer.ts`); the
shared spinner ticker in `src/tui/live-ticker.ts` and the per-tool frames in
`src/tools/transcript/` (from `modes/components/tool-execution.ts`, `tools/read-renderer.ts`,
`tools/bash.ts`, `tui/code-cell.ts`); the thinking pulse, speed gauge, and prose fold in
`src/tui/thinking-pulse.ts` and `src/tui/thinking-display.ts` (from
`modes/components/assistant-message.ts` and `utils/thinking-display.ts`).

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
