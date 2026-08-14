# dsh-skill-viewer

[简体中文](README.zh.md)

A DSH plugin for managing skills right from the web UI — no command line needed.

<img width="602" height="599" alt="image" src="https://github.com/user-attachments/assets/6ccb50e5-05ce-4264-97e3-4372d096be3e" />

## Features

- Skill card list: preview installed skills; expand a card to read the full content
- Status tags: Enabled / Disabled, styled like the built-in plugin list
- Management: hot enable/disable switch, delete, search by name; the page refreshes on entry
- Add skills: choose a single `.md` file or a directory bundle (folder with a top-level `SKILL.md`); invalid content is rejected with a reason

## Install

1. Install the package (its bundle layer auto-mounts it — no config editing)

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-skill-viewer
   ```

2. Restart the gateway

   ```bash
   dsh-restart
   ```

   Then refresh the page: Settings → Skills appears right below Plugins.

## CLI

The package ships a `dsh-skills` command for terminal-based management (also hot; works while the gateway is down):

```bash
dsh-skills list                # list skills with their state
dsh-skills disable <name>      # disable
dsh-skills enable <name>       # enable
dsh-skills delete <name>       # delete (asks for confirmation)
```

## How it works

- State changes touch the skill files directly (`SKILL.md` ↔ `SKILL.md.disabled`); DSH's file watcher picks them up instantly — no gateway restart
- A disabled skill disappears from the `/skill` trigger and the model catalog; it stays listed (dimmed) on the page and can be re-enabled anytime
- Deployment-bundled skills are read-only: they cannot be disabled or deleted

## Uninstall

`dsh plugin --profile web remove dsh-skill-viewer`, then restart the gateway.

> This plugin was formerly named `dsh-webui-skills-viewer`. Users of the old manual install should remove the old entry from their `cordis.patch.yml` before upgrading, to avoid a duplicate mount.

## License

MIT
