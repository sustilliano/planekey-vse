# PlaneKey Versioning Standard

The one rule for how a PlaneKey version tag is calculated, and when each digit
moves. Grounded in [Semantic Versioning 2.0.0](https://semver.org/) with the
[VS Code Marketplace](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
constraints layered on top. If a change doesn't fit a rule here, default to the
smaller bump and open a discussion.

---

## TL;DR

Versions are `MAJOR.MINOR.PATCH` (e.g. `0.7.0`). Given a change, bump exactly one:

| Bump | When | Examples for PlaneKey |
| --- | --- | --- |
| **PATCH** `x.y.Z` | Backward-compatible **bug fix** only. No new surface. | A command that errored now works; a report field was wrong and is corrected; a typo in a setting description. |
| **MINOR** `x.Y.0` | Backward-compatible **new functionality**. Existing users unaffected if they ignore it. | A new command; a new setting; a new report/panel; a new capability in predictive typing. |
| **MAJOR** `X.0.0` | **Backward-incompatible** change. Something existing users rely on breaks, moves, or is removed. | Removing/renaming a command or setting; changing a report's schema in a non-additive way; changing a default that alters existing behavior. |

Reset lower digits on a bump: `0.6.3 → 0.7.0` (minor resets patch); `0.7.4 → 1.0.0` (major resets minor+patch).

**Two hard rules:**
1. The `version` in `package.json` is the single source of truth. The top `CHANGELOG.md` heading and the git tag (`vX.Y.Z`) must match it.
2. **A recorded version is immutable** (SemVer §3). Never rewrite a shipped or already-logged entry — corrections are *appended*, never edited over. See [Changelog is append-only](#the-changelog-is-append-only).

---

## What each position means

Verbatim from the spec ([semver.org](https://semver.org/)):

- **§6 — PATCH** `Z`: "MUST be incremented if only backward compatible bug fixes are introduced. A bug fix is defined as an internal change that fixes incorrect behavior."
- **§7 — MINOR** `Y`: "MUST be incremented if new, backward compatible functionality is introduced." Also when public functionality is **deprecated** (but not yet removed). MAY include internal improvements. PATCH resets to 0.
- **§8 — MAJOR** `X`: "MUST be incremented if any backward incompatible changes are introduced." MINOR and PATCH reset to 0.

The question that decides everything: **would a change break someone who is already using the current version without reading the changelog?**
- No, and it adds nothing they'd notice → **PATCH**.
- No, and it gives them something new → **MINOR**.
- Yes → **MAJOR**.

---

## What counts as what, for PlaneKey

PlaneKey's "public API" is everything a user or another tool can depend on:
its **commands**, **settings** (`planekey.*`), **views/panels**, the **MCP
server contract**, and the **report/snapshot file shapes** other tools read.

| Change | Bump |
| --- | --- |
| Add a command, setting, view, menu, or report | **MINOR** |
| Add a field to a report/JSON (additive, old readers still work) | **MINOR** |
| New behavior behind an off-by-default setting | **MINOR** |
| Fix a command that misbehaved; fix a wrong report value | **PATCH** |
| Performance/refactor with no observable surface change | **PATCH** (or none) |
| Docs, comments, tests, CI only | **no bump** (see below) |
| Remove or rename a command / setting / report field | **MAJOR** |
| Change a report's schema so existing readers break | **MAJOR** |
| Change a setting's default such that existing installs behave differently | **MAJOR** (if it breaks expectations) else MINOR |
| Raise the minimum `engines.vscode` | **MAJOR** |

**Incidental docs / chore changes** (typos, comments, tests, CI) don't move
the version. But a change that **establishes or changes a project standard or
a governed artifact** — like this versioning standard itself, a license, or a
policy — is a **PATCH**: the standard is part of what PlaneKey governs, so it's
tracked. When in doubt whether something is user- *or governance-*visible, it's
a PATCH.

**Bundled toolchain ≠ extension version.** `pk-client` and `pk-memory` carry
their own versions (e.g. `1.5.8`). The extension's `package.json` version is
independent. Upgrading the bundled toolchain is a **MINOR** (new capability) or
**PATCH** (bug-fix-only) of the *extension*, judged by its user-visible effect.

---

## Sub-minor designations (`x.y.z.Q`)

Some changes are too small to earn even a PATCH — a doc tweak, a typo, a
formatting or metadata touch — but are still worth recording. For those,
PlaneKey appends an optional **4th position: a single letter**, `x.y.z.Q`. It
logs the change in history *without moving the numeric version*.

- **Case = kind of change**
  - **Capital** (`A` `B` `C`) — a *non-functional* change: docs, comments,
    formatting, metadata. Behavior is unchanged.
  - **lowercase** (`a` `b` `c`) — a *typo correction*.
- **Letter = intent**
  - **`A` / `a`** — testing
  - **`B` / `b`** — proposing changes
  - **`C` / `c`** — combining different ideas together

Examples: `0.10.0.A` (a non-functional, testing-oriented note on `0.10.0`);
`0.10.0.b` (a typo fix while proposing changes).

**How it's recorded.** A sub-minor is a `###` sub-heading *under* its base
`## x.y.z` section in the changelog — e.g. `### 0.10.0.A` inside `## 0.10.0`.
That keeps the numeric `## x.y.z` headings as the canonical release list (what
the version-integrity check reads) and nests the letter notes beneath their
release, so adopting the scheme needs no code change — it stays purely
non-functional.

**It never touches `package.json`.** The `.vsix` and the VS Code Marketplace
accept **only numbers** (`X.Y.Z`), so a letter can't live there. At `0.10.0.A`,
`package.json` stays `0.10.0`; the letter lives only in the changelog (and, if
useful, a git tag like `v0.10.0.A`).

**Never for functional changes.** Anything that changes behavior — even a
one-line fix — is a numeric PATCH/MINOR/MAJOR, not a sub-minor. The letter is
strictly for non-functional (capital) and typo (lowercase) notes.

**Ordering:** `0.10.0 < 0.10.0.A < 0.10.0.B < … < 0.10.1`.

---

## The `0.y.z` rule and the road to `1.0.0`

SemVer **§4**: "Major version zero (0.y.z) is for initial development. Anything
MAY change at any time. The public API SHOULD NOT be considered stable."

PlaneKey is pre-1.0. Our policy while in `0.y.z`:

- We still bump **honestly**: features move MINOR, fixes move PATCH. (We do
  *not* pile features into PATCH — that was the mistake that produced the
  `0.4.2 → 0.4.7` patch-chain, later corrected to `0.5.0`.)
- A breaking change in `0.y.z` bumps **MINOR** (there is no major to move yet),
  and is called out loudly in the changelog as **BREAKING**.

**Ship `1.0.0` when:** the command + settings + report surface is one we're
willing to keep stable, and we publish a real stable Marketplace release. After
`1.0.0`, breaking changes cost a MAJOR — so `1.0.0` is a commitment, not a
milestone of "it feels done."

---

## Pre-releases and the Marketplace constraint

The VS Code Marketplace **does not accept SemVer pre-release tags** — a version
must be **one to four integers** (`X.Y.Z`), so `0.8.0-beta.1` is rejected.
Therefore:

- **What ships to the Marketplace is always plain `X.Y.Z`.**
- To run a **pre-release channel** (users opt in via "Install Pre-Release
  Version"), publish with `vsce publish --pre-release` and adopt the
  Marketplace convention: **odd minor = pre-release, even minor = stable**
  (e.g. `1.3.x` = pre-release for the upcoming `1.4.0`). We adopt odd/even
  **only once we run a pre-release channel** — until then, plain sequential
  `X.Y.Z` is correct and simplest, and our `0.y.z` numbers are not bound by it.
- **SemVer pre-release tags** (`-alpha.1`, `-rc.1`) and **build metadata**
  (`+sha.abc123`) MAY be used on **git tags and internal builds** (they sort
  per SemVer §9–11), but MUST be stripped from anything published to the
  Marketplace.

---

## Commit → bump mapping

We write [Conventional Commits](https://www.conventionalcommits.org/). They map
directly to the bump, so the version is calculable from history:

| Commit type | Bump |
| --- | --- |
| `fix:` | PATCH |
| `feat:` | MINOR |
| `feat!:` / `fix!:` / any `BREAKING CHANGE:` footer | MAJOR (MINOR while in `0.y.z`, flagged BREAKING) |
| `docs:` `chore:` `refactor:` `test:` `style:` `ci:` | no bump (unless user-visible → PATCH) |

The release bump is the **highest** bump among the commits since the last tag.

---

## The changelog is append-only

This is SemVer §3 ("released version contents MUST NOT be modified") applied to
the record itself:

- **One `## X.Y.Z` heading per shippable change set**, newest at the top.
- **Never rewrite or delete** an existing entry — not to re-word, not to
  "clean up," not to re-scope. The changelog is a historical record, not a
  marketing surface.
- **Corrections are appended.** If a shipped/logged claim was wrong, add a new
  bullet or entry that says so; leave the original in place. (See the `0.4.7`
  "Correction — snapshots are append-only" entry for the pattern.)
- **Backfilled history is labeled.** If you reconstruct a version that predates
  the changelog, mark it *"backfilled from git history"* and cite the evidence
  (commit, tag, or artifact) — never present a reconstruction as if it were
  written at the time. (See `0.4.0` / `0.4.1`.)
- Keep numbering **contiguous and accurate**: don't lump N changes under one
  version, and don't leave gaps unexplained.

---

## Where the version lives

1. `package.json` `"version"` — **source of truth.**
2. `CHANGELOG.md` top heading — must equal it, newest first.
3. Git tag `vX.Y.Z` on the release commit — must equal it.
4. The published `.vsix` manifest — must equal it (plain `X.Y.Z`).

A release is inconsistent if these disagree. CI should check 1↔2↔3.

---

## Decision procedure

1. Does any change break an existing command / setting / report / MCP
   contract, or move the `engines.vscode` floor? → **MAJOR** (or MINOR + a
   loud BREAKING note while in `0.y.z`).
2. Otherwise, does it add any user-visible capability (command, setting, view,
   report, additive field)? → **MINOR**.
3. Otherwise, does it fix incorrect behavior a user could observe? → **PATCH**.
4. Otherwise (docs / chore / internal refactor) → **no numeric bump**. If it's
   worth recording, add a **sub-minor** `x.y.z.Q` note (capital letter for
   non-functional/docs, lowercase for typos) — see
   [Sub-minor designations](#sub-minor-designations-xyzq). `package.json` does
   not move.
5. Apply the bump to `package.json`, reset lower digits, add the matching
   `## X.Y.Z` changelog heading (append-only), and tag `vX.Y.Z`. (A sub-minor
   adds a `### x.y.z.Q` note under its base section and leaves `package.json`
   alone.)

---

## Worked examples (our own history)

| Version | Change | Rule |
| --- | --- | --- |
| `0.4.0` | Initial upload; toolchain bundled | Initial development baseline (§4) |
| `0.4.1` | Predictive-typing inline provider added | New functionality → **MINOR** |
| `0.4.2–0.4.7` | Chat, license, route intelligence, snapshots… | Each a new feature → each was a **MINOR**; the original patch-chain was **wrong** and was rolled up to `0.5.0` |
| `0.5.0` | Rollup release of the above | Features → **MINOR** |
| `0.6.0` | Predictive typing rebuilt to run locally from reports | New capability → **MINOR** |
| `0.7.0` | Hands-on "Get Started" welcome | New feature → **MINOR** |
| `0.7.1` | This versioning standard added | Governed standard → **PATCH** |
| `0.8.0` | Version-integrity check in the snapshot system | New capability → **MINOR** |
| `0.9.0` | CLI-dispatch routes + 0–100 score; pk-client doctor | New capability → **MINOR** |
| `0.10.0` | Interactive, self-explaining snapshot report | New capability → **MINOR** |
| `0.10.0.A` | Sub-minor letter scheme adopted (this) | Non-functional / docs → **sub-minor** (capital A) |

---

_Sources: [Semantic Versioning 2.0.0](https://semver.org/) ·
[VS Code — Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) ·
[Conventional Commits](https://www.conventionalcommits.org/)._
