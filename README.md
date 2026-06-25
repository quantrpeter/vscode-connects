# VSCode Connect

An SSH client for VSCode, developer by Hong Kong Programming Society

![](resources/banner.png)

## Features

- **SSH Hosts sidebar** — a "VSCode Connect" icon in the activity bar opens a panel with a search bar, Add / Edit / Delete buttons, and your saved hosts.
- **Saved credentials** — each host stores its address, port, username, and (optionally) password in a configuration form.
- **Double-click to connect** — double-click a host to open an interactive SSH session as a tab in the editor area. The saved password is supplied automatically (password and keyboard-interactive auth are both supported; SSH agent keys are used when no password is saved).
- **Sync across machines** — hosts are saved via VSCode's `globalState` with Settings Sync enabled. Sign in with GitHub (or Microsoft), turn on Settings Sync, and choose "Extensions" (or "All") so your hosts roam to every machine where you use VS Code.

> **Security note:** passwords are stored in plain form inside the synced extension state so they can roam between machines. If you don't want that, leave the password field empty and use SSH keys / agent auth instead.

## Import from `~/.ssh/config`

Click **Import ~/.ssh/config** in the sidebar to import your existing OpenSSH client config.

- Each `Host` entry becomes a saved host (wildcard / negated patterns are skipped).
- `HostName`, `Port`, `User`, `IdentityFile`, `ServerAliveInterval`, and `TCPKeepAlive` are read automatically.
- Imported hosts are grouped under **SSH config** so you can tell them apart.
- If an imported host has a readable private key, its content is stored for key-based auth.

## Usage

1. Click the **VSCode Connects** icon in the activity bar.
2. Click **Add** to create a host, or **Import ~/.ssh/config** to pull in existing OpenSSH hosts. Fill in name, host, port, username, and optionally a password, then **Save & Connect**.
3. Double-click any host in the list to open an SSH terminal in the editor.
4. Type in the search bar to filter hosts; select a host and use **Edit** or **Delete** to manage it.

![](/screencap/1.png)

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VSCode to launch an Extension Development Host.

## Packaging

```bash
npm install -g @vscode/vsce
vsce package
```

Install the generated `.vsix` via "Extensions: Install from VSIX...".
