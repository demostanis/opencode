---
name: opencode-visual-testing
description: Use this skill whenever visually testing, debugging, or reproducing opencode TUI behavior with screenshots, keyboard input, terminal windows, Xephyr, xdotool, import, urxvt, or `bun run dev`. This skill sets up an isolated Xephyr display running opencode with the Big Pickle model and explains how to drive it with xdotool and capture screenshots with ImageMagick import.
---

# Skill: opencode-visual-testing

Use this workflow when a TUI bug needs visual verification instead of relying on logs alone. The goal is to create a disposable nested X display, run the development TUI inside it, drive it from the outside, and capture screenshots that show the exact layout state.

## Bundled scripts

- `scripts/start-xephyr-opencode.sh`: starts an isolated Xephyr display, loads `~/.Xresources`, and launches `urxvt` running `bun run dev --model opencode/big-pickle`.
- `scripts/restart-opencode.sh`: restarts the opencode instance inside the Xephyr `urxvt` window.
- `scripts/kill-xephyr-opencode.sh`: kills the saved Xephyr, `urxvt`, and headless parent X session.

Run scripts from the repository root so paths resolve to the current checkout.

The `urxvt` window title is expected to become `OpenCode` once the TUI starts. The script still saves `WINDOW_ID` because matching by id is more reliable than matching by title after opencode changes it.

## Start a visual test display

Start the environment with:

```bash
.agents/skills/opencode-visual-testing/scripts/start-xephyr-opencode.sh --headless
```

The script prints the nested `DISPLAY`, the terminal window id, and copy-paste examples for `xdotool` and `import`. Use that exact `DISPLAY` value for all input and screenshots. Do not use the host desktop display unless you intentionally want to control the real desktop.

The start script also writes state to `.agents/skills/opencode-visual-testing/.state/env`, so the restart script can find the same display later.

The start script runs `xrdb -merge ~/.Xresources` inside the nested display before launching `urxvt`, so terminal font and color resources are applied to the visual test window.

## Drive the TUI

Use `xdotool` with the nested display from the start script. Pattern:

```bash
DISPLAY=<nested-display> xdotool search --name "OpenCode" windowfocus --sync
DISPLAY=<nested-display> xdotool windowfocus --sync <window-id>
DISPLAY=<nested-display> xdotool type --delay 1 "execute sleep 2"
DISPLAY=<nested-display> xdotool key Return
DISPLAY=<nested-display> xdotool type --delay 1 "hello"
DISPLAY=<nested-display> xdotool key ctrl+x
DISPLAY=<nested-display> xdotool key Return
```

Prefer separate `xdotool` calls for key chords and text entry. This makes failures easier to localize and avoids accidentally typing literal key names into the terminal.

## Capture screenshots

Use ImageMagick `import` against the nested display:

```bash
DISPLAY=<nested-display> import -window root /tmp/opencode-visual-test.png
```

Read the screenshot file with the image-capable file reader before making UI conclusions. If the screenshot catches an intermediate state, wait a little longer and capture again.

## Restart the opencode instance

After changing code, restart the TUI inside Xephyr with:

```bash
.agents/skills/opencode-visual-testing/scripts/restart-opencode.sh
```

The restart script reads the saved display state, focuses the saved `urxvt` window id, sends `Ctrl-C`, and lets the wrapper relaunch `bun run dev --model opencode/big-pickle`.

## Kill the Xephyr session

When the visual test display is no longer needed, stop the saved Xephyr session with:

```bash
.agents/skills/opencode-visual-testing/scripts/kill-xephyr-opencode.sh
```

The kill script reads `.state/env`, terminates the saved `urxvt`, Xephyr, and optional Xvfb processes, then removes the state file.

## Verification loop

1. Start Xephyr with `start-xephyr-opencode.sh --headless` if it is not already running.
2. Reproduce the UI flow with `xdotool` using the printed `DISPLAY`.
3. Capture a screenshot with `import` using the same `DISPLAY`.
4. Inspect the screenshot and logs together.
5. Edit code, run the package typecheck, restart with `restart-opencode.sh`, and repeat until the screenshot proves the fix.

For this repository, run type checks from `packages/opencode` with `bun typecheck`.
