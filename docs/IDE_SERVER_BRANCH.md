# PlaneKey IDE Add-on v0.2.0 — IDE/Server Branch

This version keeps `pk-client` as canon and adds controls for the second leg:

- `pk-memory` / TMrFS artifact memory
- RootRabbit:Rgano structural scans
- `pk-operator` safe action / incident workflow

The extension is still a thin IDE wrapper. It does not duplicate the security logic. It calls the installed PlaneKey CLIs and surfaces status, reports, and incidents inside VS Code/Cursor.

## Required tools

- `pk-client.cmd` from PlaneKey Client v1.5.7 canon or newer
- `pk-memory.cmd` from PlaneKey:TMrFS/Rgano v1.5.8
- `pk-operator.cmd` from PlaneKey Operator v1.6.0

If the commands are not on PATH, use the PlaneKey commands to set explicit paths.
