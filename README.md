# Android Panel

Mirrors a connected Android device into a VS Code sidebar panel and lets you drive it with the mouse.

The device screen is captured over `adb` and drawn in a webview. Clicks, drags and wheel scrolls are
translated back into `input tap` / `input swipe` events, so the panel is interactive rather than a
read-only preview. No native modules, no bundler, no npm dependencies — the extension is two files.

## Why

Existing options either open a separate always-on-top window (scrcpy) or require a full
Android Studio device mirror. Neither docks into the editor. This one behaves like any other
sidebar view: it lives in the activity bar, follows the editor layout, and stops polling when
hidden.

## Requirements

- `adb` on `PATH`, or an absolute path in `androidPanel.adbPath`
- USB debugging enabled on the device, and the host authorised

## Install

There is no marketplace release. Clone into the editor's extensions directory and reload:

```
git clone https://github.com/amophi/android-panel.git \
  ~/.vscode/extensions/android-panel
```

On VS Code forks, substitute the matching directory — for example `~/.antigravity-ide/extensions`.
A directory junction or symlink from the extensions directory to a working copy also works, which
is convenient while developing.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `androidPanel.adbPath` | `adb` | Path to the `adb` executable |
| `androidPanel.package` | *(empty)* | Package launched when the panel opens. Empty mirrors whatever is on screen |
| `androidPanel.intervalMs` | `600` | Capture interval in milliseconds |
| `androidPanel.serial` | *(empty)* | Device serial. Empty picks automatically, preferring physical devices over emulators |

When `androidPanel.package` is set, device selection prefers a device that actually has that
package installed — useful when an emulator is running alongside a phone.

## Controls

| Action | Effect |
| --- | --- |
| Click | `input tap` |
| Drag | `input swipe` |
| Wheel | Vertical swipe |
| ← / ⌂ | Back / Home key events |
| ▶ | Launch the configured package |
| ↻ | Re-detect the device |

## Behaviour notes

Frames are hashed and only pushed to the webview when the screen actually changed, so a static
screen costs one `screencap` per interval and nothing else. Capture stops entirely while the view
is hidden.

`screencap` can only read **physical** displays. Virtual displays — including the ones `scrcpy
--new-display` creates — are rejected by both `screencap` and `screenrecord`, which take physical
display IDs only. The panel therefore shows the device's own screen, and the device cannot be used
for something else at the same time.

Expect roughly 1–2 frames per second at the default interval. That is fine for turn-based or
text-heavy apps and poor for anything animated; this is a capture-and-poll design, not a video
stream.

## License

MIT
