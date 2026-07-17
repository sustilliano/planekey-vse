# Changelog

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
