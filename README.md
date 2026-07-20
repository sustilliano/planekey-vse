# PlaneKey VSE — RootRabbit:Rgano capability snapshot (`rgano-reports-demo`)

This branch is a **live, self-referential demonstration**: the PlaneKey
toolchain profiling its own repository. It was produced by cloning `main`,
branching, and running the bundled `pk-memory` tools against the source —
no external services, no network. The committed [`reports/`](reports/) are
the raw output; this README explains what the tools are, what they measure,
and what the repo is capable of.

> **What this repo is:** PlaneKey Trust Layer — a VS Code / Cursor extension
> that bundles the whole PlaneKey toolchain (`pk-client`, `pk-memory`, and
> the Env-Observer MCP server) under [`toolchain/`](toolchain/). One
> install, three surfaces: the editor, the CLI, and MCP.

## The tools in this snapshot

| Tool | Command | What it measures |
| --- | --- | --- |
| **RootRabbit:Rgano** structure scan | `pk-memory rgano scan` | Groups every artifact by *structural behavior* (its dispatch surface, imports, functions → a signature) rather than by exact hash. Near-duplicate/forked files share a signature even when bytes differ. |
| **Repository Planning Graph (RPG)** | `pk-memory memory rpg` | The call/dependency graph: modules, symbols, dependencies, and inferred capabilities. Emits `rpg.sql` for a queryable SQLite graph. |
| **Timeline** | `pk-memory memory timeline` | Temporal / version view of the tree; emits `pk-timeline.sql`. |
| **TMrFS memory** | `pk-memory memory build` | Canon candidates (what to trust as source-of-truth), residue candidates (agent runtime leftovers, secrets, injected material), lineage, and trust/content indexes. |

## What "routes" mean here — interconnectivity, not just HTTP

The internet is not the only thing with routes. **RootRabbit:Rgano gauges
the health and interconnectivity between programs, functions and tools** —
in this repo, in your systems, and in whatever a customer runs it on. So a
"route" is any **named hand-off point** where one part of a system reaches
another, across domains:

| Kind | Example | Meaning |
| --- | --- | --- |
| `GET /path` | `app.get('/users')`, `@app.route(...)`, `#[get(...)]` | HTTP endpoint (Express / Flask / FastAPI / Actix) |
| `CMD` / `CALL` | `registerCommand('id')` / `executeCommand('id')`; a manifest's `contributes.commands` | An IDE/tool command a file **provides** or **invokes** |
| `TOOL` | `registerTool('name')`, `@tool(...)` | A registered tool (e.g. an MCP server capability) |
| `EVT` | `emitter.on('name')`, `.emit('name')` | A pub/sub or IPC channel (generic stream/lifecycle events filtered out) |
| `MSG` | `postMessage({ type: 'name' })` | A webview / worker IPC message type |

That is why this repo — a VS Code extension + CLIs with **no web server** —
is still highly interconnected. From the [structure scan](reports/rgano/vse-rgano/RGANO_STRUCTURE_SCAN.md):

```text
- 437.5 code_module  toolchain/pk-client/bin/pk-client.js  routes=1  imports=10   (EVT request — its HTTP-ish surface)
- 197.0 package_manifest package.json                      routes=39 imports=0    (39 CMD routes — the wiring hub)
- 111.5 code_module  src/extension.js                      routes=1  imports=6    (CALL vscode.openFolder)
-  37.5 planekey_component src/planekey-integration-glue.ts routes=2  imports=5    (2 CMD registrations)
```

The RPG puts numbers on the deeper connectivity: **10 modules, 524 symbols,
1,615 dependencies, 5 inferred capabilities** — see
[`reports/rpg/vse-rpg/rpg.md`](reports/rpg/vse-rpg/rpg.md).

### Accuracy note (this branch is also a bug trail)

The first commit on this branch ran an **older extractor** with two flaws,
kept in history on purpose so the fix is auditable:

1. **Too narrow** — it only matched HTTP routes, so command/tool/event
   interconnectivity read as `routes=0` and the reports looked broken.
2. **False positives** — it matched example routes sitting inside comments
   and ```` ``` ```` doc fences (`pk-memory.js` "found" routes in its own
   regex documentation).

Route detection is now **code-aware** (a route only counts when its anchor
token is real code, never a comment or fenced example) **and cross-domain**
(HTTP + command + tool + event + IPC). `git log`/`git diff` on
`reports/rgano/vse-rgano/RGANO_STRUCTURE_SCAN.md` between the two commits is
the before/after.

## Reproduce it

```bash
git clone https://github.com/sustilliano/planekey-vse
cd planekey-vse
git checkout -b rgano-reports-demo main

# The whole toolchain ships inside the extension — nothing else to install.
PKM=toolchain/pk-memory/pk-memory.js
node $PKM rgano scan      . --name vse-rgano       # structural fingerprint
node $PKM memory rpg      . --name vse-rpg         # planning / dependency graph
node $PKM memory timeline . --name vse-timeline    # temporal view
node $PKM memory build    . --name vse-memory      # TMrFS canon + residue
```

Inside the editor the same suite is one command:
**`PlaneKey: Snapshot Workspace (all reports)`** (or enable
`planekey.snapshotOnStartup` to run it on activation).

Absolute paths in the report headers are normalized to `<repo-root>` so the
snapshot is reproducible and diff-friendly. The `.sql` files load with
`sqlite3` (or install `better-sqlite3` to have `pk-memory` emit `.sqlite`
directly).
