# PlaneKey Trust Layer for VS Code / Cursor
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/U8K320KRK0)

**One download, three surfaces.** As of **v0.4.0** the PlaneKey toolchain is
**bundled inside the extension** — `pk-client`, `pk-memory`, and the
Env-Observer MCP server all ship under [`toolchain/`](toolchain/). You no
longer install `pk-client` separately: the editor, your terminal, and any
MCP host all drive the same bundled copy. Zero-config on a fresh install.

```text
one install ─┬─ in the editor  → PlaneKey sidebar, chat, predictive typing, scans
             ├─ from the CLI    → the bundled pk-client (PlaneKey: Show CLI Setup)
             └─ over MCP        → Env-Observer server auto-registered with the host
```

## What it does

- **Chat control board** — a full webview with five channels: *Your AI*
  (PKBridge completion), *Docs* (grounded `pk-client docs search`), *Direct*
  (E2EE Burrow send), *Inbox* (warren inbox, live unread badge), and
  *Settings*. Open it with **`PlaneKey: Open Chat`** or the 💬 button at the
  top of the PlaneKey sidebar.
- **Risk-aware predictive typing** — inline ghost-text completions in the
  editor, drawn from your own codebase's identifiers in the PlaneKey reports,
  ranked by canon (source-of-truth) with secrets suppressed. Fully local:
  no AI, no network, no per-keystroke subprocess. Run
  `PlaneKey: Index Codebase` (or any snapshot) to build the index.
- **Trust surface** — a PlaneKey status-bar badge and sidebar showing
  current-file risk and recent scan results.
- **Scans** — RepoGuard, PixelGuard, ResidueGuard, RootRabbit, SafetyNet.
- **Memory / structure** — RootRabbit:Rgano structure scans, TMrFS memory
  builds, Repository Planning Graph (RPG), canon ranking, graft plans.
- **Env-Observer MCP server** — auto-registered on VS Code 1.101+ so
  Claude / Cursor / Copilot get read-only workspace context.
- **Attestations & bundles** — dev-layer attestations and safe bundles.

## Requirements

Just VS Code (or Cursor) **1.101.0+**. The toolchain is bundled, so there is
nothing else to install for the editor experience. `node` on your `PATH` is
used to run the bundled JS tools; set `planekey.nodePath` if you need a
specific interpreter. (The MCP server needs `python3`.)

> Upgrading from v0.2.x? You can delete any `planekey.pkClientPath` /
> `planekey.pkMemoryPath` overrides — leave them blank to use the bundled
> copies. Point them somewhere only if you deliberately want an external build.

## Install for local testing

1. Open VS Code or Cursor.
2. Run **`Developer: Install Extension from Location…`** and pick this folder,
   **or** install the packaged `planekey-trust-layer-*.vsix`
   (`Extensions: Install from VSIX…`).
3. Reload if prompted.

Dev mode: open this folder and press `F5` to launch an Extension Development Host.

Use the bundled `pk-client` from your own terminal via **`PlaneKey: Show CLI
Setup`**, which prints a ready-to-paste shell alias.

## See your codebase at a glance

Run **`PlaneKey: Snapshot Workspace`** and PlaneKey hands you a single,
plain-language page — what holds your code together, what looks like the
source-of-truth, and what's worth a second look — then **Open Snapshot** to
read it. No need to understand routes or signatures to get it. Want a live
example first? The
[`rgano-reports-demo`](https://github.com/sustilliano/planekey-vse/blob/rgano-reports-demo/reports/snapshots/index.html)
branch is PlaneKey run against its own code — start at its
[`reports/snapshot.html`](https://github.com/sustilliano/planekey-vse/blob/rgano-reports-demo/reports/snapshots/2026-07-20T06-17-54-801Z/snapshot.html).

Prefer the terminal? Point the bundled `pk-memory` at any project:

```bash
git clone https://github.com/sustilliano/planekey-vse
cd planekey-vse
git checkout -b rgano-reports-demo main

PKM=toolchain/pk-memory/pk-memory.js
node $PKM rgano scan       . --name vse-rgano       # structural fingerprint
node $PKM memory rpg       . --name vse-rpg         # repository planning graph
node $PKM memory timeline  . --name vse-timeline    # temporal / version view
node $PKM memory build     . --name vse-memory      # TMrFS canon + residue
```

Reports land under `reports/`. A taste of the Rgano structure scan
(`reports/rgano/vse-rgano/RGANO_STRUCTURE_SCAN.md`) — artifacts grouped by
structural behavior, not exact hash:

```text
- 437.5 code_module      toolchain/pk-client/bin/pk-client.js  routes=1  imports=10
- 197.0 package_manifest package.json                          routes=39 imports=0
- 111.5 code_module      src/extension.js                      routes=1  imports=6
-  37.5 planekey_component src/planekey-integration-glue.ts    routes=2  imports=5
```

**`routes` measures interconnectivity, not just HTTP.** RootRabbit:Rgano
gauges how functions, tools and programs connect in *any* codebase — so a
route is any named hand-off point: HTTP endpoints (`GET /path`), IDE/tool
commands (`CMD`/`CALL`, including a manifest's `contributes.commands`),
registered tools (`TOOL`, e.g. MCP), pub/sub & IPC channels (`EVT`), and
webview messages (`MSG`). That's why this repo — a VS Code extension with no
web server — still lights up: `package.json` is the 39-command wiring hub.

Inside the editor, generate the whole suite in one step with
**`PlaneKey: Snapshot Workspace (all reports)`** (or enable
`planekey.snapshotOnStartup` to run it on activation) — or run any single
report from the sidebar: **Run Rgano Structure Scan**, **Build TMrFS
Memory**, **Build Repo DB**.

Each snapshot is written to its own timestamped folder under
`reports/snapshots/<id>/` and **never overwrites the last one** — snapshots
accumulate into a real history (`reports/snapshots/index.json` is the
append-only ledger; `index.html` lists every one). That history is the point
of a memory tool: you can watch the codebase change over time, not just see
its latest state.

## Configure

Open settings and search for `PlaneKey`, or use the Command Palette:

- `PlaneKey: Set Project Root`
- `PlaneKey: Show CLI Setup`

Common settings (all optional — blanks fall back to the bundled toolchain):

```json
{
  "planekey.projectRoot": "",
  "planekey.reportRoot": "",
  "planekey.nodePath": "",
  "planekey.predictive.enabled": true
}
```

## First commands to try

From the PlaneKey sidebar or Command Palette:

- `PlaneKey: Open Chat`
- `PlaneKey: Refresh Trust Status`
- `PlaneKey: Run RepoGuard`
- `PlaneKey: Run Rgano Structure Scan`
- `PlaneKey: Build TMrFS Memory`
- `PlaneKey: Attest Dev Layer`
- `PlaneKey: Create Safe Bundle`

## Design

The extension is the adoption UI; the bundled toolchain is the engine:

```text
VS Code/Cursor extension = adoption UI (sidebar, chat, predictive typing)
pk-client (bundled)      = local trust engine + CLI
pk-memory (bundled)      = TMrFS / RootRabbit:Rgano memory + structure
Env-Observer MCP server  = read-only workspace context for AI hosts
bridge-service           = private/SaaS control plane (bridge.planekey.dev)
```

## License

**Proprietary.** This is *not* unlicensed or public-domain software — the
`SEE LICENSE IN LICENSE-PROPRIETARY` field in `package.json` points to the
full end-user license agreement in
[`LICENSE-PROPRIETARY`](LICENSE-PROPRIETARY).

Copyright © 2026 PlaneKey, an Oregon corporation. All rights reserved. Use of
the Software is governed solely by that Agreement.
