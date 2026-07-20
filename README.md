# PlaneKey VSE — see your codebase at a glance

Point PlaneKey at a repo and it hands you a plain-language picture of what's
in there and how the pieces connect. This branch **is** that picture — taken
of PlaneKey's own code, so you can see the payoff before running anything.

### 👉 Start here: [`reports/snapshots/…/snapshot.html`](reports/snapshots/2026-07-20T06-17-54-801Z/snapshot.html)

One page, no jargon: what holds the code together, what to trust as the
source-of-truth, and what's worth a second look. You don't need to know what
a "route" or a "signature" is to read it — the same way you don't need the
blueprints to admire a building.

<sub>(GitHub shows HTML as source — download it, or open it in the editor
with **PlaneKey: Snapshot Workspace → Open Snapshot**, to see it rendered.)</sub>

## Snapshots are a history, not a single latest state

Each snapshot is written to its **own immutable, timestamped folder** and is
**never overwritten**. Take another next week and it's added alongside this
one — so `reports/snapshots/` becomes an honest record of how the codebase
changes over time, which is the whole point of a memory tool.

- [`reports/snapshots/index.html`](reports/snapshots/index.html) — the
  history: every snapshot, newest first.
- `reports/snapshots/index.json` — the append-only ledger behind it.
- `reports/snapshots/<timestamp>/` — one run, kept forever.

## Try it on your own code — ~15 seconds

The whole toolchain ships inside the extension, so there's nothing to
install:

```bash
git clone https://github.com/sustilliano/planekey-vse
cd planekey-vse

# swap in any project you want to look at:
node toolchain/pk-memory/pk-memory.js rgano scan /path/to/your/project --name mine
```

That prints a ranked, human-readable structure map. Want the full set —
snapshot page, dependency graph, timeline, and trust/memory report — in one
go? In the editor it's a single command: **PlaneKey: Snapshot Workspace**.

## What's inside this snapshot

| | What it tells you |
| --- | --- |
| 🏠 **[Snapshot page](reports/snapshots/2026-07-20T06-17-54-801Z/snapshot.html)** | The at-a-glance view. Read this first. |
| 🧭 **[Structure map](reports/snapshots/2026-07-20T06-17-54-801Z/rgano/snapshot/RGANO_STRUCTURE_SCAN.md)** | Every file ranked by how much it does and how connected it is. |
| 🕸️ **[Dependency graph](reports/snapshots/2026-07-20T06-17-54-801Z/rpg/snapshot/rpg.md)** | How functions and modules call each other (also as a queryable `.sql`). |
| 🕰️ **[Timeline](reports/snapshots/2026-07-20T06-17-54-801Z/timeline/snapshot/pk-timeline.md)** | How the tree looks over versions/time. |
| 🧠 **[Memory report](reports/snapshots/2026-07-20T06-17-54-801Z/memory/snapshot/MEMORY_REPORT.md)** | Source-of-truth vs. leftover/residue, with lineage. |

For this repo that came out to **36 files, 10 modules, 524 functions &
symbols, 1,615 links between them** — a small codebase that's densely wired.

## For the curious — what it's actually measuring

Skip this unless you want to look under the hood.

Those connections aren't abstract — they're the **actual hand-offs that make
the software do what it does**: an HTTP endpoint, an IDE command, a
registered tool, a message between components. RootRabbit:Rgano gauges that
interconnectivity in *any* codebase — yours, ours, or a customer's — not
just web servers. So `routes` counts HTTP endpoints **and** command
registrations/calls, tool registrations (MCP), pub/sub & IPC channels, and
webview messages. That's why this extension — which has no web server — is
still one of the most connected things here (`package.json` alone wires 39
commands).

> **This branch is also a bug trail.** Its first commit ran an older,
> HTTP-only extractor that also miscounted example routes sitting in
> comments and doc fences. Detection is now code-aware and cross-domain;
> `git log`/`git diff` across the branch's commits shows the before/after.

Report headers are normalized to `<repo-root>` so the snapshot is
reproducible and diff-friendly. `.sql` files load with `sqlite3`.
