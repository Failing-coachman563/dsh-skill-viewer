# dsh-skill-viewer

(English|[简体中文](README.md))

A DSH plugin for managing skills right from the web UI and terminal

<img width="602" height="599" alt="image" src="https://github.com/user-attachments/assets/6ccb50e5-05ce-4264-97e3-4372d096be3e" />

## Features

- Skill card list: preview installed skills; expand a card to read the full content
- Status tags: Enabled / Disabled, styled like the built-in plugin list
- Management: hot enable/disable switch, delete, search by name; the page refreshes on entry
- Add skills: choose a single `.md` file or a directory bundle (folder with a top-level `SKILL.md`); invalid content is rejected with a reason
- **Scoped views** (0.3.0): a skill's files live directly in its scope — global skills in `~/.dsh/skills`, workspace skills in that workspace's `.dsh/skills`. A scope bar below “Skills” (Global + each workspace, horizontally scrollable) filters the list to one scope.
- **Batch migration**: the button left of “+” batch-copies or batch-moves skills from one scope to another (select all supported; items migrate independently — one failure never aborts the rest).

## Install

1. Install the package (its bundle layer auto-mounts it — no config editing)

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-skill-viewer
   ```

   > pnpm v11 security policy: git-hosted dependencies are blocked from running
   > their prepare build scripts by default. If you see “git-hosted plugins
   > build on install...”, add the key pnpm printed above under `allowBuilds`
   > in the profile's `pnpm-workspace.yaml` and re-run; or install from the
   > release tarball instead (no git involved, no such restriction):
   >
   > ```bash
   > dsh plugin --profile web add https://github.com/Fishquito7/dsh-skill-viewer/releases/download/v0.3.0/dsh-skill-viewer-0.3.0.tgz
   > ```

2. Restart the gateway

   ```bash
   dsh-restart
   ```

   Then refresh the page: Settings → Skills appears right below Plugins.

## CLI

The package ships a `dsh-skill` command for terminal-based management (also hot; works while the gateway is down):

```bash
dsh-skill list                                  # list skills (with scope: global / workspace)
dsh-skill add <path>                            # add to global (a single .md file, or a bundle dir with a top-level SKILL.md)
dsh-skill add <path> --workspace D:\projA       # add directly into a workspace
dsh-skill scope <name> --global                  # migrate one skill to global
dsh-skill scope <name> --workspace D:\projA      # migrate one skill into a workspace (--copy to copy)
dsh-skill migrate <name...|--all> --from <global|path> --to <global|path> [--copy] [--yes]
                                                 # batch migrate (copy or move)
dsh-skill disable <name>       # disable
dsh-skill enable <name>        # enable
dsh-skill delete <name>        # delete (asks for confirmation)
```

The CLI only scans the cwd-anchored project roots and the user roots; add `--cwd <workspace-path>` to manage a different workspace's skills.

## How it works

The plugin doesn't parse skills itself — it's just a management surface over the skill files: every action in the page (or via `dsh-skill`) ends up as a change to the skill files on disk (`SKILL.md`), and DSH's own file watcher notices immediately. That's why enable/disable, add, delete and migration are all hot — no gateway restart.

- A skill's entity lives directly in its scope folder: global = `~/.dsh/skills`, workspace = `<workspace>/.dsh/skills` — no hidden store, no junctions: after uninstalling the plugin the skills are plain files DSH keeps discovering
- Disable = rename `SKILL.md` to `SKILL.md.disabled`, enable = rename it back
- Changing scope = physically copying/moving the files into the target scope folder (validated first, rolled back on failure)
- Deployment-bundled skills are read-only: they cannot be disabled or deleted

## Uninstall

```bash
dsh plugin --profile web remove dsh-skill-viewer
```



## License

MIT
