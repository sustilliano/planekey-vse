# Changelog

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
