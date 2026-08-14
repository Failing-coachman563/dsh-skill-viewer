# dsh-webui-skills-viewer

[English](README.md)

DSH 插件，可直接在web界面快速管理skill状态，无需再打开命令行管理。

<img width="602" height="599" alt="image" src="https://github.com/user-attachments/assets/6ccb50e5-05ce-4264-97e3-4372d096be3e" />


## 功能

- skill卡片列表：预览已注册安装的skill。
- skill状态：启用、停用状态标签
- skill管理：开关热启用/停用、删除；skill名称搜索
- skill添加：选择单文件（`.md`）或目录束（含顶层 `SKILL.md` 的文件夹），不合规内容会被拒绝并提示原因

## 安装

1. 安装本包

   ```bash
   dsh plugin --profile web add github:Fishquito7/dsh-webui-skills-viewer
   ```

2. 重启网关
   ```bash
   dsh-restart
   ```

## 卸载

`dsh plugin --profile web remove dsh-webui-skills-viewer`，删除 patch 条目并重启网关。

## License

MIT
