# AGENTS.md — vscode-extension branch

You're on the **vscode-extension** deployable branch. Content is the
VS Code extension `planekey-trust-layer` v0.2.0. At the root:
`package.json`, `src/extension.js`, `assets/`, `docs/`.

## What this product does

Grounds Claude / Cursor / Copilot inside the IDE with the env-observer
MCP (read-only workspace context). Surfaces planekey incidents and
patch suggestions inline. Hosts the branch-aware predictive-typing +
VCS integration + licensing-compliance + multi-project layer that we
extracted out of the misfiled mobile_app/ .py wrappers.

## First queries

```sql
-- on databases:rpg/products-rpg/rpg.sqlite
SELECT s.symbol_name, s.symbol_type, s.file_path
FROM rpg_symbols s JOIN rpg_modules m ON m.id=s.module_id
WHERE m.name LIKE 'vscode-extension%';
```

## Key files

- `package.json` — extension manifest. 18 PlaneKey commands. Targets
  VS Code 1.85+. Publisher: `conversationchain`.
- `src/extension.js` — main activator
- `src/planekey-{init,integration-glue,vcs-integration,vcs-hooks,
  multi-project,licensing-compliance}.ts` — the integration layer
- `docs/{IDE_SERVER_BRANCH,ENTERPRISE_WEDGE,ROADMAP}.md`

## Where things flow

- New VS Code command → wire in `package.json` `contributes.commands`
  + handler in `src/extension.js` or a new `src/planekey-*.ts`
- New MCP capability → live in bridge/mcp/, NOT here; this extension
  is the IDE adapter, the MCP server is canonical on bridge

## System-health toolbox

The VSCode extension invokes the locally-installed `pk-client` for the
shared system-health verbs: `doctor`, `self-update`, and
`memory`. See `products/system-health/README.md` on the `products`
branch for the cross-product naming + per-product invocation table.
