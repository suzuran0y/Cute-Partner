# 哦鲸鲸 · Codex Desktop Pet

[🇺🇸 English](codex-pet_EN.md) | [🇨🇳 中文](codex-pet.md)

The Codex pet is a chibi adaptation of Cute-Partner’s Live2D character. She keeps her blue curls, fin-shaped ears, whale tail, and little whale apron. She blinks, runs left and right, waves, and jumps. She also has animations for waiting, working, reviewing results, and reacting to failures. The sprite sheet includes sixteen gaze directions.

This version runs independently in Codex Pets. Integration with Cute-Partner’s desktop host and DeepSeek Harness is planned for later. The jumping GIF in the README previews the animation.

## Load the pet in Codex

1. Download [`pet.json`](../extras/codex-pet/cute-partner-whale/pet.json) and [`spritesheet.png`](../extras/codex-pet/cute-partner-whale/spritesheet.png) from the repository. Keep their names and put both in a folder named `cute-partner-whale`.
2. On Windows, open `%USERPROFILE%\.codex\pets\` in File Explorer and copy the entire `cute-partner-whale` folder into it. Create the `pets` directory if needed. If you set `CODEX_HOME`, use its `pets` directory.
3. In Codex mode in the ChatGPT desktop app, open **Settings → Pets**, select **Refresh**, and choose **哦鲸鲸**. To show the floating pet, enter `/pet` in a chat or choose **Show pet** from the command menu. [Official Pets documentation](https://learn.chatgpt.com/docs/pets#use-a-floating-pet)

You can also ask a Codex agent to prepare the installation files. Send it this prompt:

```text
Please install Cute-Partner’s 哦鲸鲸 desktop pet on this computer.
Get pet.json and spritesheet.png from extras/codex-pet/cute-partner-whale in https://github.com/suzuran0y/Cute-Partner. Use the local files if the repository is already in my workspace.
Put both files in Codex’s pets/cute-partner-whale directory. Use CODEX_HOME if it is set, or .codex under my user directory otherwise. Verify both files after copying them, then tell me how to refresh Settings → Pets and select 哦鲸鲸.
```

## Contribute

Share feedback, animation ideas, or installation problems in [Issues](https://github.com/suzuran0y/Cute-Partner/issues). You can also open an issue or submit a pull request to improve the animations or explore how the character could show activity status.
