# dsh-webui-skills-viewer

DSH Web UI 插件：在设置面板“插件”下方新增“技能”栏，浏览当前会话的技能目录，支持热启用/停用、删除与添加技能。

[English](README.md)

## 安装

前置：DSH CLI（`0.1.0-rc.6` 及以上）与 `dsh web`。

1. 安装本包：

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-webui-skills-viewer
   ```

2. 编辑 `~/.dsh/profiles/web/cordis.patch.yml`（Windows：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: skills-viewer
         name: dsh-webui-skills-viewer
   ```

3. 重启网关（先停止、再启动 `dsh web`），刷新页面。

## 功能

- 技能卡片列表：搜索、启停状态标签、开关热启用/停用、删除
- 添加技能：选择单文件（`.md`）或目录束（含顶层 `SKILL.md` 的文件夹），不合规内容会被拒绝并提示原因
- 随包附带 CLI：`dsh-skills list|enable|disable|delete`（热生效，无需重启）
- 中英双语文案

## 卸载

`dsh plugin --profile web remove dsh-webui-skills-viewer`，删除 patch 条目并重启网关。

## License

MIT
