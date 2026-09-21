# Android Panel

Mirrors a connected Android device into a VS Code sidebar panel and lets you drive it with the mouse.

The panel speaks the scrcpy server protocol directly: it pushes `scrcpy-server` to the device, opens
an `adb reverse` tunnel, and decodes the H.264 stream in the webview with WebCodecs. Clicks, drags and
wheel scrolls go back as `input tap` / `input swipe`, so the panel is interactive rather than a
read-only preview. No native modules, no bundler, no npm dependencies.

Because it talks to the scrcpy server rather than shelling out to `screencap`, it can mirror a
**virtual display** — the app runs on a display of its own and the device's real screen stays free
for something else.

## Why

Existing options either open a separate always-on-top window (scrcpy) or require a full
Android Studio device mirror. Neither docks into the editor. This one behaves like any other
sidebar view: it lives in the activity bar, follows the editor layout, and stops polling when
hidden.

## Requirements

- `adb` on `PATH`, or an absolute path in `androidPanel.adbPath`
- USB debugging enabled on the device, and the host authorised
- For `stream` mode: the `scrcpy-server` file from a scrcpy release, and an editor whose Chromium
  provides WebCodecs. `androidPanel.scrcpyVersion` must match the server file, or the server refuses
  the connection.

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
| `androidPanel.mode` | `stream` | `stream` decodes the scrcpy H.264 stream; `screencap` polls `adb exec-out screencap` |
| `androidPanel.adbPath` | `adb` | Path to the `adb` executable |
| `androidPanel.scrcpyServerPath` | *(empty)* | `stream` mode: path to the `scrcpy-server` file |
| `androidPanel.scrcpyVersion` | `4.1` | Version string the server expects |
| `androidPanel.newDisplay` | *(empty)* | `stream` mode: virtual display to create, e.g. `1440x3120/560`. Empty mirrors the real screen |
| `androidPanel.maxSize` | `1080` | `stream` mode: cap the encoded frame's long edge. 0 encodes at full resolution |
| `androidPanel.maxFps` | `0` | `stream` mode frame cap; 0 is unlimited |
| `androidPanel.keepStreamWhenHidden` | `true` | Keep the stream running while the view is hidden |
| `androidPanel.stayAwake` | `false` | Ask the server to keep the device awake while charging |
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
| ⤢ | Toggle between fitting the whole screen and filling the panel width |

## Stream protocol

Measured against scrcpy 4.1. The server is started as:

```
CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / \n  com.genymobile.scrcpy.Server 4.1 scid=<8 hex digits> log_level=info \n  audio=false control=false new_display=<WxH/dpi>
```

`scid` is parsed with `Integer.parseInt(s, 16)`, so it must fit in a signed 32-bit int — the high
bit has to be clear. The server then connects back through the reverse tunnel and writes:

```
device name   64 bytes, NUL-padded
codec meta    16 bytes: codec id (4) + unknown (4) + width (4) + height (4)
frames        repeated: PTS/flags (8) + length (4) + Annex-B payload
```

In the PTS word, bit 62 marks a config packet (SPS/PPS) and bit 61 marks a key frame. The config
packet is prepended to the following key frame before handing it to `VideoDecoder`, which is
configured from the profile and level found in the SPS.

Input does not use the scrcpy control socket. `control=false` is passed and taps are sent with
`adb shell input -d <displayId> tap`, which keeps the client to one socket.

## Keeping it cheap

A phone screen is far larger than a sidebar. Encoding 1440x3120 and scaling it down in the webview
wastes most of the work, so `maxSize` asks the server to scale before encoding. On a 1440x3120
display `maxSize: 1080` yields 498x1080 — still sharper than the panel is wide:

| | encoded | bandwidth | pixels per frame |
| --- | --- | --- | --- |
| unscaled | 1440x3120 | ~50 KB/s | 4.49 M |
| `maxSize: 1080` | 498x1080 | ~13 KB/s | 0.54 M |

Scaling separates two coordinate spaces: the video is 498x1080 but `input tap` still expects display
coordinates. The panel asks the device with `wm size -d <id>` rather than reusing the video size.

## Cleaning up after itself

Killing the local `adb shell` does not kill the server process on the device. A leaked server keeps
its virtual display alive, and the next run then launches the app onto a *different* display while
the panel streams the stale one — the symptom is a panel showing an empty secondary launcher.

The client therefore kills its own server by `scid` on shutdown, and sweeps any orphaned servers and
`scrcpy_*` reverse tunnels on startup. A health check every eight seconds confirms the display still
exists and the configured package is still on top of it, restarting or relaunching if not.

## Behaviour notes

Tearing the stream down destroys the virtual display, and the activity on it dies with it. Switching
to another sidebar view would therefore restart the app, so in `stream` mode the stream keeps running
while the view is hidden and the webview retains its decoder. Set `keepStreamWhenHidden` to `false`
to trade that for idle battery, at the cost of restarting the app each time the panel is reopened.

In `screencap` mode there is no such state, so capture stops entirely while the view is hidden.

In `screencap` mode frames are hashed and only pushed when the screen actually changed, so a static
screen costs one `screencap` per interval and nothing else. That mode can only read **physical**
displays: virtual displays are rejected by `screencap` and `screenrecord` alike, which take physical
display IDs only. Use `stream` mode for a virtual display.

## License

MIT
