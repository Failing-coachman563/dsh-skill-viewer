# dsh-webui-skills-viewer

A DSH Web UI plugin: adds a **Skills** section below **Plugins** in the settings panel to browse the current session's skill catalog, with hot enable/disable, delete, and add.

[简体中文](README.zh.md)

## Install

Requires DSH CLI (`0.1.0-rc.6`+) and the `web` profile.

1. Install the package:

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-webui-skills-viewer
   ```

2. Edit `~/.dsh/profiles/web/cordis.patch.yml` (`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` on Windows):

   ```yaml
   - insert:
       - id: skills-viewer
         name: dsh-webui-skills-viewer
   ```

3. Restart the gateway (stop, then start `dsh web`) and refresh the page.

## Features

- Skill card list: search, enabled/disabled tags, hot enable/disable switch, delete
- Add skills: choose a single `.md` file or a directory bundle (folder with a top-level `SKILL.md`); invalid content is rejected with a reason
- Bundled CLI: `dsh-skills list|enable|disable|delete` (hot, no restart)
- Simplified Chinese and English UI

## Uninstall

`dsh plugin --profile web remove dsh-webui-skills-viewer`, remove the patch entry, restart the gateway.

## License

MIT
