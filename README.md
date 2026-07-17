# PlaneKey Trust Layer for VS Code / Cursor
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/U8K320KRK0)

PlaneKey Trust Layer is the IDE front door for PlaneKey. It does not replace `pk-client`; it calls your installed `pk-client` and displays trust state inside VS Code-compatible editors.

## What it does

- Shows a PlaneKey status bar badge.
- Adds a PlaneKey sidebar.
- Runs RepoGuard, PixelGuard, ResidueGuard, RootRabbit, and SafetyNet.
- Shows current-file risk based on path/category.
- Creates dev attestations and safe bundles.
- Opens PlaneKey report folders.

## Requirements

Install PlaneKey Client first, then make sure this works in PowerShell or terminal:

```powershell
pk-client.cmd --help
```

On Windows, `pk-client.cmd` is preferred because PowerShell may block `.ps1` shims.

## Install in VS Code / Cursor for local testing

1. Unzip this folder.
2. Open VS Code or Cursor.
3. Run `Developer: Install Extension from Location...`.
4. Pick the unzipped `planekey-vscode-extension-v0.1.0` folder.
5. Reload the editor if prompted.

Alternative dev mode:

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.

## Configure

Open settings and search for `PlaneKey`, or use command palette:

- `PlaneKey: Set pk-client Path`
- `PlaneKey: Set Project Root`

Useful settings:

```json
{
  "planekey.pkClientPath": "pk-client.cmd",
  "planekey.projectRoot": "C:\\DEV\\cc-master\\conversationchain_master\\pkspace",
  "planekey.reportRoot": "C:\\DEV\\cc-master\\conversationchain_master\\pkspace\\reports"
}
```

## First commands to try

From the PlaneKey sidebar or Command Palette:

- `PlaneKey: Refresh Trust Status`
- `PlaneKey: Run RepoGuard`
- `PlaneKey: Run PixelGuard`
- `PlaneKey: Run ResidueGuard Map`
- `PlaneKey: Run RootRabbit Scan`
- `PlaneKey: Run SafetyNet`
- `PlaneKey: Attest Dev Layer`
- `PlaneKey: Create Safe Bundle`

## Design

The extension is intentionally thin:

```text
VS Code/Cursor extension = adoption UI
pk-client               = local trust engine
server-core             = embedded/live verifier
bridge-service          = private/SaaS control plane
```

This keeps the IDE add-on safe, small, and portable.


## v0.2.0

Adds TMrFS/Rgano and Operator controls for the IDE/server branch.
