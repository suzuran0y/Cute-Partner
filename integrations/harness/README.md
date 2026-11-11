# 可爱的助手 · Cute-Partner

Windows x64 的 Live2D 桌面伙伴。安装此插件后，可以让 Harness 协助安装基础程序，再启动角色。日常直接在角色窗口中交流、交付任务和查看记忆。

## 首次使用

告诉 Harness：“请检查可爱的助手是否已安装；如果没有，先展示安装计划，得到我的确认后安装基础程序，再启动角色。”

- `cute_partner_status`：检查基础程序，未安装时显示准备方式。
- `cute_partner_install`：先返回下载大小与位置；你确认后，以 `confirm: true` 安装。
- `cute_partner_start`：启动角色。首次成功加载后会创建“哦鲸鲸”桌面图标。

基础程序包含 Electron、默认角色和预置音色，校验下载文件的 SHA-256 后安装到当前用户的 `CutePartner` 目录，不需要另行安装 Node.js 或 pnpm。模型账户由本机 Harness 管理。

语音识别与 CosyVoice3 按需安装，见[3.4. 语音组件安装](https://github.com/suzuran0y/Cute-Partner/blob/main/README_CN.md#sec34)。卸载此插件保留独立桌面程序和个人资料；退出角色使用角色菜单。

已有独立安装时，也可将 `CUTE_PARTNER_HOME` 指向项目根目录。当前验证基线为 Harness `0.2.1-rc.2`。

---

# Cute-Partner

A Windows x64 Live2D desktop companion. This plugin helps install the base application and launch the character. Everyday conversation, tasks, and memory live in the character window.

Ask Harness to check the installation, show the installation plan, install after your approval, and launch the character.

- `cute_partner_status` checks the base installation.
- `cute_partner_install` shows the plan first; `confirm: true` downloads and installs it after approval.
- `cute_partner_start` launches the character, which creates a desktop shortcut on its first successful load.

The base package includes Electron, the default character, and voice presets. The installer verifies SHA-256 and installs under the current user's `CutePartner` directory. No separate Node.js or pnpm installation is needed for the base application. Harness manages model credentials locally.

Speech recognition and CosyVoice3 are optional; see [3.4. Optional Voice Components](https://github.com/suzuran0y/Cute-Partner/blob/main/README.md#sec34). Removing this plugin retains the independent application and personal data. Exit the character from its own menu.

Set `CUTE_PARTNER_HOME` to use an existing installation. The current validation baseline is Harness `0.2.1-rc.2`.
