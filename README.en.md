# dsh-skill-viewer

(English|[简体中文](README.md))

A DSH plugin for managing skills right from the web UI and terminal

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

The package ships a `dsh-skill` command for terminal-based management (also hot; works while the gateway is down):

```bash
dsh-skill list                 # list skills with their state
dsh-skill add <path>           # add a skill (a single .md file, or a bundle dir with a top-level SKILL.md)
dsh-skill disable <name>       # disable
dsh-skill enable <name>        # enable
dsh-skill delete <name>        # delete (asks for confirmation)
```

## How it works

The plugin doesn't parse skills itself — it's just a management surface over the skill files: every action in the page (or via `dsh-skill`) ends up as a change to the skill files on disk (`SKILL.md`), and DSH's own file watcher notices immediately. That's why enable/disable, add and delete are all hot — no gateway restart.

- Disable = rename `SKILL.md` to `SKILL.md.disabled`, enable = rename it back
- A disabled skill leaves the `/skill` trigger and the model catalog; it stays dimmed on the page and can be re-enabled anytime
- Deployment-bundled skills are read-only: they cannot be disabled or deleted

## Uninstall

```bash
dsh plugin --profile web remove dsh-skill-viewer
```



## License

MIT
