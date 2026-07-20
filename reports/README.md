# RootRabbit:Rgano reports — `rgano-reports-demo`

This branch is a live snapshot of the PlaneKey RootRabbit:Rgano / TMrFS
report suite run against **this repository itself**. It was produced by
cloning `main`, creating the `rgano-reports-demo` branch, and running the
bundled `pk-memory` toolchain (`toolchain/pk-memory/pk-memory.js`) — no
external services, no network.

Reproduce it end-to-end:

```bash
git clone https://github.com/sustilliano/planekey-vse
cd planekey-vse
git checkout -b rgano-reports-demo main

# The whole toolchain ships inside the extension — nothing else to install.
NODE=node
PKM=toolchain/pk-memory/pk-memory.js

$NODE $PKM rgano scan   . --name vse-rgano       # structural fingerprint
$NODE $PKM memory rpg   . --name vse-rpg         # repository planning graph
$NODE $PKM memory timeline . --name vse-timeline # temporal/version view
$NODE $PKM memory build . --name vse-memory      # TMrFS canon + residue
```

## What's here

| Report | Path | What it answers |
| --- | --- | --- |
| **Rgano structure scan** | [`rgano/vse-rgano/`](rgano/vse-rgano/RGANO_STRUCTURE_SCAN.md) | Groups artifacts by *structural behavior* (routes / imports / signature) rather than exact hash. |
| **Repository Planning Graph (RPG)** | [`rpg/vse-rpg/`](rpg/vse-rpg/rpg.md) | Modules, symbols, dependencies, inferred capabilities. Emits `rpg.sql` for a queryable SQLite graph. |
| **Timeline** | [`timeline/vse-timeline/`](timeline/vse-timeline/pk-timeline.md) | Version/temporal view of the tree. Emits `pk-timeline.sql`. |
| **TMrFS memory** | [`memory/vse-memory/`](memory/vse-memory/MEMORY_REPORT.md) | Canon candidates, residue candidates, lineage, trust/content indexes. |

Absolute paths in the report headers have been normalized to `<repo-root>`
so the snapshot is reproducible and diff-friendly. The `.sql` files can be
loaded with `sqlite3` (or install `better-sqlite3` to have `pk-memory`
emit the `.sqlite` directly).
