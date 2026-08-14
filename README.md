# dsh-skill-viewer

([English](README.en.md)|简体中文)


DSH 插件，可直接在 web 界面快速管理 skill 状态，同时在终端加入快捷的skill管理命令。命令行命令请见下文

<img width="602" height="599" alt="image" src="https://github.com/user-attachments/assets/6ccb50e5-05ce-4264-97e3-4372d096be3e" />

## 功能

- skill 卡片列表：预览已注册安装的 skill，点击卡片可展开查看完整内容
- skill 状态：启用、停用状态标签，与内置插件列表同款样式
- skill 管理：开关热启用/停用、删除；按名称搜索；进入页面自动刷新
- skill 添加：选择单文件（`.md`）或目录束（含顶层 `SKILL.md` 的文件夹），不合规内容会被拒绝并提示原因

## 安装

1. 安装本包（bundle 层自动挂载，无需编辑配置文件）

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-skill-viewer
   ```

2. 重启网关

   ```bash
   dsh-restart
   ```

   重启后刷新页面：设置 → “插件”下方即可看到“技能”。

## 命令行

随包附带 `dsh-skills` 命令，可直接在终端管理技能（同样热生效，网关关闭时也能用）：

```bash
dsh-skills list                # 列出技能（含启停状态）
dsh-skills disable <name>      # 停用
dsh-skills enable <name>       # 启用
dsh-skills delete <name>       # 删除（需确认）
```

## 工作原理

- 状态改动直接作用于技能文件（`SKILL.md` ↔ `SKILL.md.disabled`），DSH 的文件监听器即时感知，无需重启网关
- 停用后技能会从 `/skill` 触发词与模型目录中消失；页面内仍以置灰状态展示，可随时重新启用
- 随部署附带的技能（bundled）为只读，不可停用或删除

## 卸载

`dsh plugin --profile web remove dsh-skill-viewer`，然后重启网关。

> 本插件前身为 `dsh-webui-skills-viewer`；使用旧版手动安装的用户升级前请先移除 `cordis.patch.yml` 中的旧条目，避免重复挂载。

## License

MIT
