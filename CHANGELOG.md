# Changelog

## 0.8.0

- **Version integrity is now a check in the snapshot system** — the same
  "scan and flag" shape as residue / canon / secrets / license, enforcing
  `docs/VERSIONING.md` instead of just documenting it.
  `src/checks/versionIntegrity.js` verifies the declared version against the
  changelog, the git tags, and the size of the change:
  - flags `package.json` ↔ top `CHANGELOG` heading mismatch, missing or
    duplicate headings, non-SemVer headings, and a version behind its tag;
  - reads Conventional Commits since the last tag and flags an **under-bump**
    — e.g. features shipped as a patch (the exact `0.4.2→0.4.7` mistake);
  - runs on every `Snapshot Workspace` (writes `VERSION_INTEGRITY.json`,
    shown in a "Version & governance" section on the snapshot page) and on
    demand via **`PlaneKey: Check Version Integrity`** (Command Palette +
    Actions list).

## 0.7.1

- Add the PlaneKey versioning standard, `docs/VERSIONING.md` (referenced from
  `AGENTS.md`): SemVer + the VS Code Marketplace constraints, the
  commit→bump mapping, and the append-only changelog rule. Establishing a
  governed standard is itself tracked — hence a PATCH, not "no bump."

## 0.7.0

- **Hands-on "Get Started" welcome.** A first-run (and on-demand via
  `PlaneKey: Get Started`) welcome screen that lets the user choose how to
  begin, and actually *runs* the steps:
  - **Follow along** — replay the predictive-typing job: index the codebase,
    then type and watch canon-ranked ghost text appear (button runs
    `planekey.indexCodebase`; "How we built this" opens the changelog).
  - **Dive in** — take a first snapshot of your own project (button runs
    `planekey.snapshotWorkspace`), then keep snapshotting to build history.

  No template repo, no branches, no monorepo: the "there → here" is the
  append-only snapshot history the user builds by doing it. Shown once via
  `globalState`; reopenable from the Command Palette and the Actions list.
  New `src/panels/welcomePanel.js`.

## 0.6.0

- **Predictive typing is now one working, local feature.** It was split
  between a wired-in provider that called a non-existent
  `pk-memory memory suggest` verb (so it returned nothing) and a dead,
  never-built duplicate extension under `docs/predictive-typing-alt/`.
  Consolidated into the single extension and rebuilt to run **entirely
  locally — no AI, no network, no per-keystroke subprocess**:
  - New `src/providers/predictiveIndex.js` builds an in-memory index from the
    PlaneKey reports we already generate (`STRUCTURE_INDEX.json` for the real
    identifiers — functions, imports, routes, config keys; `CANON_CANDIDATES`
    for ranking; `RESIDUE_CANDIDATES` to suppress secrets).
  - `predictiveTypingProvider.js` rewritten to serve inline ghost-text
    completions synchronously from that index, ranked by canon and blended
    with the open document's own identifiers, like Copilot/Ponicode but
    deterministic and offline. (A future sentence-transformers pass could
    re-rank semantically; deliberately not required.)
  - Only genuinely sensitive files (`secret_or_private_material`) are
    excluded — a function name is not a secret, so the broad keyword-based
    `agent_runtime_residue` no longer drops the codebase's own API.
  - `PlaneKey: Index Codebase` and every snapshot now rebuild the index;
    added `planekey.predictive.minPrefix` / `planekey.predictive.maxSuggestions`.
  - Removed the dead `docs/predictive-typing-alt/` scaffold.

## 0.5.0

Feature release. Rolls up the work recorded as 0.4.2–0.4.7 below, which is
kept as the development trail rather than collapsed. Highlights:

- Chat control board surfaced in the editor (0.4.2).
- README + license corrected for the already-bundled v0.4.0 toolchain (0.4.3).
- `pk-memory` route detection made code-aware and broadened from HTTP-only to
  cross-domain interconnectivity (0.4.4).
- `PlaneKey: Snapshot Workspace` and the plain-language snapshot page
  (0.4.5–0.4.6).
- Snapshots made immutable and append-only, with a kept history (0.4.7).

This is a minor bump (features), not a patch — the 0.4.2–0.4.7 numbering was
patch-style and is retained only as the in-development record.

## 0.4.2

- Surface the PlaneKey Chat control board in the editor. The `ChatPanel`
  webview (Your AI / Docs / Direct / Inbox / Settings) is now wired into
  the extension and reachable from:
  - Command Palette — `PlaneKey: Open Chat`, `PlaneKey: Open Inbox`,
    plus channel shortcuts for Docs search and Direct (E2EE) send.
  - The PlaneKey sidebar — title-bar chat/inbox buttons on both views and
    "Open Chat" / "Open Inbox" entries at the top of the Actions list.
  - `planekey.openInbox` deep-links straight into the warren inbox.

  The panel is backed by the bundled pk-client and polls the warren inbox
  every 45s, badging unread count on the panel title.

## 0.4.3

- Docs: rewrite README for the v0.4.0 "one download, three surfaces"
  model — the pk-client / pk-memory / Env-Observer MCP toolchain is now
  bundled under `toolchain/`, not a separate install. Adds a reproducible
  RootRabbit:Rgano report example pointing at the `rgano-reports-demo`
  branch, plus a License section.
- License: `package.json` now declares
  `SEE LICENSE IN LICENSE-PROPRIETARY` instead of `UNLICENSED`, so npm /
  marketplace tooling stops reporting the extension as unlicensed. The
  software is proprietary, governed by `LICENSE-PROPRIETARY` — not
  public-domain.

## 0.4.4

- **Routes now measure interconnectivity, not just HTTP — and stop
  hallucinating.** Two problems in `pk-memory`'s structure extractor:
  1. *Too narrow.* "Routes" only matched web-framework endpoints
     (`app.get`, `@app.route`, `#[get]`), so a VS Code extension / CLI /
     MCP server — which route via **commands, tools, events and IPC**, not
     HTTP — always scored `routes=0`, making the reports look broken even
     though the repo is densely interconnected. RootRabbit:Rgano exists to
     gauge how functions, tools and programs connect in *any* codebase, so
     route detection now also captures: `CMD`/`CALL` (command registration
     & invocation, incl. a VS Code manifest's `contributes.commands`),
     `TOOL` (registered tools / MCP), `EVT` (pub/sub & IPC channels, with
     generic stream/process lifecycle events filtered out), and `MSG`
     (webview/worker `postMessage` types). `package.json` now reports its
     44 command routes; `chatPanel.js` its webview IPC channels; etc.
  2. *False positives.* It scanned raw text, counting example routes inside
     comments and ```` ``` ```` doc fences (`pk-memory.js` "found" 2 in its
     own regex docs). Detection is now code-aware via a line-oriented
     `computeCodeMask`: a route only counts when its anchor token is real
     code, not a comment or fenced example. Verified against
     JS/Python/Rust fixtures. JS route path constrained to one line.

## 0.4.5

- **New `PlaneKey: Snapshot Workspace (all reports)` command.** Runs the
  full report suite — Rgano structure scan, Repository Planning Graph,
  timeline, and TMrFS memory — into the reports folder under a stable
  `snapshot` name, so repeated runs overwrite the same folders and can be
  diffed across a work session (the "pk snapshot" behaviour). Available in
  the Command Palette, the PlaneKey sidebar title bar, and the Actions
  list. Opt into running it on activation with
  `planekey.snapshotOnStartup`.

## 0.4.6

- **A snapshot you can just look at.** The snapshot also renders a single,
  plain-language page (`reports/snapshot.html`, and **Open Snapshot** in the
  editor) — what holds the codebase together, what looks like source-of-truth,
  and what's worth a review — no need to understand routes or signatures to
  read it. The full technical reports stay in `reports/` for anyone who wants
  to look under the hood. Generated by `src/panels/snapshotCard.js`.

## 0.4.7

- **Correction — snapshots are append-only, not overwritten.** The two
  bullets above described "Snapshot Workspace" writing to a stable `snapshot`
  name and overwriting the same folders each run. That was wrong for a
  memory/lineage tool — overwriting destroys history. Changed before release:
  each run now writes an immutable, timestamped `reports/snapshots/<id>/` that
  is never overwritten. `reports/snapshots/index.json` is the append-only
  ledger of every run; `index.html` is the derived history view; each snapshot
  keeps its own `snapshot.html`. (Recorded as a correction rather than an edit
  to the bullets above, so the changelog stays an accurate record.)

## 0.4.1

- Predictive-typing inline completion provider, backed by pk-client +
  pk-memory (commit `ec0d97d`, where the version bumped 0.4.0 → 0.4.1).
- PlaneKey emblem / theme-aware activity-bar icon (`assets/planekey.svg`).

  _Backfilled from git history — these versions predate the changelog and
  were not recorded at the time._

## 0.4.0

- Initial published extension. The PlaneKey toolchain — pk-client, pk-memory,
  and the Env-Observer MCP server — was bundled under `toolchain/` in this
  first upload ("one download, three surfaces"), shipped as
  `planekey-trust-layer-0.4.0.vsix`. No later commit "adds" pk-client because
  it was present from this initial 0.4.0 upload (verified: the 0.4.0 vsix
  contains `toolchain/pk-client/`, and the initial commit `9d11a1c` is
  `version: 0.4.0`).
- Proprietary license (`LICENSE-PROPRIETARY`); pk-client terminal command.

  _Backfilled from git history / the 0.4.0 vsix._

## 0.2.1

- Add five new commands that drive the pk-client v0.1.5.8 bridge-consumer
  subcommands. Each prompts for the required inputs (versions / file
  picker / extractor choice) then asks "Local only or Submit to
  bridge.planekey.dev?" before shelling out to pk-client.
  - `PlaneKey: Submit Flight Report (to Home Bridge)`
  - `PlaneKey: Submit Canon Analysis (to Home Bridge)`
  - `PlaneKey: Submit Forensics Attribution (to Home Bridge)`
  - `PlaneKey: Submit Rgano Signature Packet (to Home Bridge)`
  - `PlaneKey: Submit RootRabbit Health (to Home Bridge)`

  The home bridge is **bridge.planekey.dev** — not a configurable URL.
  pk-client owns auth (session token + HMAC secret); the IDE just
  passes `--submit` when the user picks that option. Local-only mode
  needs no network and no secrets.

## 0.1.0

- Initial VS Code/Cursor-compatible PlaneKey Trust Layer extension.
- Adds PlaneKey sidebar and status bar.
- Wraps pk-client commands for RepoGuard, PixelGuard, ResidueGuard, RootRabbit, SafetyNet, dev attestations, and safe bundle creation.
