# 哦鲸鲸 · Codex 桌宠

[🇨🇳 中文](codex-pet.md) | [🇺🇸 English](codex-pet_EN.md)

Codex 版的哦鲸鲸是从 Cute-Partner 的 Live2D 角色改编的 Q 版桌宠，保留了蓝色卷发、鳍耳、鲸尾和印着小鲸鱼的围裙。她有眨眼待机、左右跑动、挥手、跳跃等动作，也有等待回应、专注工作、检查结果和失败反馈的动画。精灵图还包含十六个视线方向。

目前这一版在 Codex 的 Pets 中独立使用。与 Cute-Partner 的桌面宿主和 DeepSeek Harness 的联动留待后续开发。README 里的跳跃 GIF 是动作预览。

## 加载到 Codex

1. 从仓库下载 [`pet.json`](../extras/codex-pet/cute-partner-whale/pet.json) 和 [`spritesheet.png`](../extras/codex-pet/cute-partner-whale/spritesheet.png)，保留原文件名，放到同一个 `cute-partner-whale` 文件夹。
2. 在 Windows 文件资源管理器中打开 `%USERPROFILE%\.codex\pets\`，把整个 `cute-partner-whale` 文件夹复制进去。如果 `pets` 目录不存在，先新建它。如果设置过 `CODEX_HOME`，则使用该目录下的 `pets`。
3. 在 ChatGPT 桌面应用的 Codex 模式中打开「设置 → Pets（宠物）」，点击「刷新」，再选择「哦鲸鲸」。如果桌面浮层还没显示，在聊天输入 `/pet`，或在命令菜单选择「显示宠物」。[Pets 官方文档](https://learn.chatgpt.com/docs/pets#use-a-floating-pet)

也可以让 Codex agent 帮你准备安装文件。把下面这段发给它：

```text
请帮我在这台电脑上安装 Cute-Partner 的哦鲸鲸桌宠。
从 https://github.com/suzuran0y/Cute-Partner 仓库的 extras/codex-pet/cute-partner-whale 目录取得 pet.json 和 spritesheet.png。如果当前工作区已有该仓库，直接使用本地文件。
将这两个文件放进 Codex 的 pets/cute-partner-whale 目录。优先使用 CODEX_HOME，未设置时使用我的用户目录下的 .codex。复制后核对两个文件，然后告诉我如何在设置 → Pets 里刷新并选择「哦鲸鲸」。
```

## 一起开发

欢迎在 [Issues](https://github.com/suzuran0y/Cute-Partner/issues) 分享使用体验、动作建议或安装问题。也欢迎开一个 Issue 或提交 PR，一起完善动画，或者为角色提供状态反馈的思路。
