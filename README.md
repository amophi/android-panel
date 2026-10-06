# Android Panel

Mirrors a connected Android device into a VS Code sidebar panel and lets you drive it with the mouse.

The panel speaks the scrcpy server protocol directly: it pushes `scrcpy-server` to the device, opens
an `adb reverse` tunnel, and decodes the H.264 stream in the webview with WebCodecs. Clicks, drags and
wheel scrolls go back over scrcpy's control socket as touch and scroll events, so the panel is
interactive rather than a read-only preview. No native modules, no bundler, no npm dependencies.

Because it talks to the scrcpy server rather than shelling out to `screencap`, it can mirror a
**virtual display** — the app runs on a display of its own and the device's real screen stays free
for something else.

## Why

Existing options either open a separate always-on-top window (scrcpy) or require a full
Android Studio device mirror. Neither docks into the editor. This one behaves like any other
sidebar view: it lives in the activity bar, follows the editor layout, and stops polling when
hidden.

## Requirements

The extension bundles neither `adb` nor scrcpy; it drives the copies already on the machine. A
scrcpy release ships both in one folder, so unpacking one anywhere is usually the whole setup.

- `adb`, found on `PATH` or by the discovery below, or an absolute path in `androidPanel.adbPath`
- USB debugging enabled on the device, and the host authorised
- For `stream` mode: the `scrcpy-server` file from a scrcpy release, and an editor whose Chromium
  provides WebCodecs. The version handed to the server must match the server file exactly; leaving
  `androidPanel.scrcpyVersion` empty derives it from the `scrcpy` binary sitting next to the file, so
  upgrading scrcpy does not silently break the panel.

## Install

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=amophi.android-panel),
or by searching for *Android Panel* in the Extensions view:

```
code --install-extension amophi.android-panel
```

VS Code forks — Cursor, Windsurf, VSCodium, Antigravity — read [Open VSX](https://open-vsx.org/extension/amophi/android-panel)
rather than the Microsoft marketplace. The same release goes to both, so searching the Extensions
view works in those editors as well.

### From a release

Every `v*` tag attaches a built `.vsix` to a
[GitHub release](https://github.com/amophi/android-panel/releases), which is the quickest way
to get a specific version onto a machine that has neither git nor a marketplace it can reach:

```
gh release download v0.2.1 --repo amophi/android-panel --pattern '*.vsix'
code --install-extension android-panel-v0.2.1.vsix
```

On a VS Code fork, substitute its own CLI -- `cursor`, `antigravity-ide`, `codium`.

### From source

Clone into the editor's extensions directory and reload the window:

```
git clone https://github.com/amophi/android-panel.git \
  ~/.vscode/extensions/android-panel
```

On VS Code forks, substitute the matching directory — `~/.antigravity-ide/extensions`,
`~/.cursor/extensions`, and so on. `git pull` in that directory updates the extension; there is
nothing to build.

If the machine has no git, build a `.vsix` where one is available and install that instead:

```
npx @vscode/vsce package --no-dependencies --out android-panel.vsix
code --install-extension android-panel.vsix
```

While developing, a directory junction or symlink from the extensions directory to a working copy
avoids copying after every edit.

## Setting it up on a new machine

`stream` mode needs `adb` and the `scrcpy-server` file. Both ship together in a scrcpy release, so
unpacking scrcpy anywhere is usually enough — leave `adbPath` and `scrcpyServerPath` empty and the
extension looks for them:

- whatever `scrcpy` or `adb` resolve to on `PATH`
- `%LOCALAPPDATA%\scrcpy`, including one level of subdirectories, since scrcpy releases unpack into
  a versioned folder such as `scrcpy-win64-v4.1`
- the Android SDK's `platform-tools`
- `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`

Set the two paths explicitly only when discovery misses. `scrcpyVersion` can stay empty as well; it
is read from the `scrcpy` binary next to the server file.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `androidPanel.show` | `phone` | `phone` mirrors the device's own screen; `app` gives one app a display of its own |
| `androidPanel.mode` | `stream` | `stream` decodes the scrcpy H.264 stream; `screencap` polls `adb exec-out screencap` |
| `androidPanel.adbPath` | *(empty)* | Path to the `adb` executable. Empty runs the discovery above |
| `androidPanel.scrcpyServerPath` | *(empty)* | `stream` mode: path to the `scrcpy-server` file |
| `androidPanel.scrcpyVersion` | *(empty)* | Version string the server expects. Empty asks the `scrcpy` binary next to the server file |
| `androidPanel.newDisplay` | *(empty)* | `stream` mode: virtual display to create, e.g. `1440x3120/560`. Empty mirrors the real screen |
| `androidPanel.maxSize` | `1080` | `stream` mode: cap the encoded frame's long edge. 0 encodes at full resolution |
| `androidPanel.maxFps` | `0` | `stream` mode frame cap; 0 is unlimited |
| `androidPanel.keepStreamWhenHidden` | `true` | Keep the stream running while the view is hidden |
| `androidPanel.wakeDevice` | `true` | Wake the device on start, and again if it falls asleep. Taps are dropped while it sleeps |
| `androidPanel.stayAwake` | `false` | Ask the server to keep the device awake while charging |
| `androidPanel.package` | *(empty)* | Package launched when the panel opens. Empty mirrors whatever is on screen |
| `androidPanel.intervalMs` | `600` | `screencap` mode: capture interval in milliseconds |
| `androidPanel.serial` | *(empty)* | Device serial. Empty picks automatically, preferring physical devices over emulators |

When `androidPanel.package` is set, device selection prefers a device that actually has that
package installed — useful when an emulator is running alongside a phone.

A `package/activity` component is started exactly as written, for an activity that registers
no launcher entry and so cannot be resolved from a package name alone.

## What a virtual display can show

A virtual display is a second screen, not a second phone. Nothing puts the whole device onto
one:

- Left empty, the display gets whatever secondary launcher the vendor supplies. On One UI that
  is the Samsung DeX launcher, which carries a handful of apps and no app drawer.
- Pointing `androidPanel.package` at the device's own launcher does not help. Measured on One
  UI 8 / Android 16, `com.sec.android.app.launcher/.activities.LauncherActivity` does become
  the resumed activity on the virtual display, but it paints only the wallpaper -- the icon
  grid and the drawer never appear, because the launcher is not built to run anywhere but the
  device's own screen.
- `SECONDARY_HOME` resolves to nothing on that device, so there is no third-party launcher
  slot to fill either.

So a virtual display is the right tool for **one app at a time**, named in
`androidPanel.package`, with the device's own screen left free. To drive the whole phone,
mirror the real display instead: leave `newDisplay` empty. That shows everything and every
app works, but the keyguard is part of what gets mirrored, and a fingerprint cannot be
pressed from the panel. Unlock the device once by hand; because the panel keeps it awake, it
will not lock itself again while the panel is open.

## Controls

| Action | Effect |
| --- | --- |
| Click | A finger pressed and lifted, for as long as the button is held |
| Drag | A finger dragged, live, along the path the mouse takes |
| Wheel | A mouse wheel scroll at the pointer, one notch at a time |
| Keyboard | After a click on the screen: text, Enter, Backspace, arrows, shortcuts. Ctrl+V pastes the computer's clipboard |
| ← / ⌂ | Back / Home key events |
| ▶ | Launch the configured package |
| ↻ | Re-detect the device |
| ⊞ | List the device's apps and start one here |
| ⤢ | Toggle between fitting the whole screen and filling the panel width |

Every edge of a gesture reaches the device as it happens: down on press, moves while dragging, up
on release. So holding the button is a long press, a game sees a button held for as long as it is
held, and a drag that stops before release stays where it stopped instead of flinging on. A wheel
notch is Android's own scroll unit, the step a mouse plugged into the phone would take.

The picture can rotate under the pointer: a game that asks for landscape turns the virtual display
with it. Positions are sent in pixels of the frame on show, with that frame's size, and the server
maps them onto the display through its own scaling and rotation. It drops an event measured against
a size that is no longer current, so a click in flight during a rotation is lost rather than
misplaced, and a finger held down across one is cancelled rather than released as a click.

### Typing

A click on the screen also sends the keyboard there; the picture gets an outline while it does,
and a click anywhere else in the editor takes the keyboard back. Text is typed through the
editor's own input method, so Korean, Japanese or any other IME composes as usual: what is still
being composed shows over the picture, and each finished character is sent. Keys that type
nothing -- Enter, Backspace, Delete, Tab, Escape, the arrows, Home, End, Page Up and Down -- and
any letter or digit held with Ctrl, Alt or Meta are sent as Android key presses, so Ctrl+A
selects all on the device whatever the input language.

How the text gets in depends on what it is. The scrcpy server types text key by key through the
virtual keyboard's key map, which covers ASCII and nothing else, so ASCII goes that way. Anything
else -- Hangul, for one -- is put on the device clipboard and pasted, which is the only way an app
can be handed it without an input method installed for the purpose. Two things follow: the
device clipboard is left holding the last text pasted this way, and the app must accept the paste
key, as ordinary text fields do. Ctrl+V pastes the computer's clipboard the same way.

In `screencap` mode there is no clipboard to paste through and `input keyevent` takes no
modifiers, so only ASCII text and plain keys get through, and the panel says so the first time
something does not.

## Stream protocol

Measured against scrcpy 4.1. The server is started as:

```
CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / \
  com.genymobile.scrcpy.Server 4.1 scid=<8 hex digits> log_level=info \
  audio=false clipboard_autosync=false power_on=false new_display=<WxH/dpi>
```

`scid` is parsed with `Integer.parseInt(s, 16)`, so it must fit in a signed 32-bit int — the high
bit has to be clear. The server then connects back through the reverse tunnel twice, video first
and control second, and writes on the first:

```
device name   64 bytes, NUL-padded
codec id      4 bytes, "h264"
then 12-byte headers, repeated; the top bit of the first byte tells the two kinds apart:
  session     flags (4, top bit set) + width (4) + height (4), no payload
  media       PTS/flags (8) + length (4) + Annex-B payload
```

A session header comes before the first frame and again whenever the capture restarts, which is
what a rotation does. It carries no payload, and its last word is the new height: a client that
takes it for a media header reads the height as a payload length and never finds its place in the
stream again. Earlier versions of the panel did exactly that: the first game to ask for landscape
rotated the virtual display, and the stream came apart as "corrupt", taking the display and the
game with it.

In a media header's PTS word, bit 62 marks a config packet (SPS/PPS) and bit 61 marks a key frame.
The config packet is prepended to the following key frame before handing it to `VideoDecoder`,
which is configured from the profile and level found in the SPS, and set up again for every new
session.

Input goes over the control socket, in the messages scrcpy's own client writes: touch, scroll and
key events, text, a clipboard paste for text the key map cannot type, and `RESET_VIDEO` when the
webview's decoder needs a key frame to start again from.
The server injects them itself, so an event costs a socket write rather than an `adb shell input`
process, and a touch is a finger on a touchscreen, which is the only kind of input many games read.
`clipboard_autosync=false` keeps the server from sending the phone's clipboard back on the same
socket; nothing here would read it, and like audio it has no business leaving the device.
`power_on=false` stops the server pressing POWER on a dark screen: waking is left to
`androidPanel.wakeDevice`, and done with a key that cannot turn the screen off instead.
Touch and scroll are held back until the first session header, since before it the server has no
mapping for positions and would inject them as raw display pixels.

Measured on a Galaxy S25+, a touch sent over the control socket reached Android's input dispatcher
in a median 2 ms. The same touch as `adb shell input tap` took 70 ms, most of it starting processes,
and it only went out once the mouse button was released.

`screencap` mode has no server and so no control socket. It writes `input` commands into one
long-lived `adb shell` instead, with at most one move in flight and wheel turns added up while the
shell is busy. What those commands can be depends on the Android version, which the panel asks
once:

| Android | Touch | Wheel |
| --- | --- | --- |
| 14 QPR3 and later | live `motionevent`, as in `stream` mode | `input mouse scroll` |
| 12 to 14 | live `motionevent` | a short drag that holds still before lifting |
| 10 and 11 | live `motionevent`, with no CANCEL | the same drag |
| 9 and earlier | `tap`, or a `swipe` replayed on release | a slow `swipe` |

## Keeping it cheap

A phone screen is far larger than a sidebar. Encoding 1440x3120 and scaling it down in the webview
wastes most of the work, so `maxSize` asks the server to scale before encoding. On a 1440x3120
display `maxSize: 1080` yields 498x1080 — still sharper than the panel is wide:

| | encoded | bandwidth, idle screen | pixels per frame |
| --- | --- | --- | --- |
| unscaled | 1440x3120 | ~50 KB/s | 4.49 M |
| `maxSize: 1080` | 498x1080 | ~13 KB/s | 0.54 M |

Those bandwidth figures are for a screen that is not moving, which is most of the time: H.264
sends almost nothing while nothing changes. A screen in motion costs about a hundred times as
much, and then the frame rate is what decides the bill. Measured on the same phone at
`maxSize: 1080`, scrolling a long list continuously for ten seconds:

| `maxFps` | delivered | bandwidth | per frame |
| --- | --- | --- | --- |
| 12 | 12.0 fps | 304 KB/s | 25.4 KB |
| 60 | 59.1 fps | 1260 KB/s | 21.3 KB |
| 0 (default) | 118.1 fps | 1255 KB/s | 10.6 KB |

Bandwidth flattens out because frames get cheaper as they get more frequent — less changes
between two of them. So capping the rate buys decoding work back, not bandwidth: 60 costs the
same to transfer as unlimited while halving what the webview has to decode, and on a panel this
size 60 and 118 are hard to tell apart.

Two things that look like they should matter and do not. `maxSize` does not limit the rate:
dropping it from 1080 to 720 left the frame rate unchanged at 118 fps. Nor does the base64 the
frames are encoded into on the way to the webview, which came to 1.8 ms per second of video at
118 fps — under 0.2% of one core.

Scaling separates two coordinate spaces: the video is 498x1080 while the display is 1440x3120, and
a rotation swaps both. The panel does not translate between them. It sends positions in video
pixels with the video size attached, and the server, which knows the current scaling and rotation,
does the mapping. An earlier version asked `wm size`, which reports the display's natural
orientation whatever the rotation, so every tap in landscape went to the wrong place.

## Cleaning up after itself

Killing the local `adb shell` does not reliably kill the server process on the device, so the
client does not depend on it either way. A leaked server keeps
its virtual display alive, and the next run then launches the app onto a *different* display while
the panel streams the stale one — the symptom is a panel showing an empty secondary launcher.

The client therefore kills its own server by `scid` on shutdown, and on startup cleans up after
whichever of its own earlier runs did not get that far. It knows which those are because it
generates the `scid` and records it before starting anything, so cleanup never has to guess:
sweeping every server and every `scrcpy_*` tunnel would take out a scrcpy session running
alongside the panel, which is measurably what used to happen to that session's tunnel. A health check every eight seconds confirms the display still
exists and the configured package is still on top of it, restarting or relaunching if not.

## Behaviour notes

Tearing the stream down destroys the virtual display, and the activity on it dies with it. Switching
to another sidebar view would therefore restart the app, so in `stream` mode the stream keeps running
while the view is hidden and the webview retains its decoder. Set `keepStreamWhenHidden` to `false`
to trade that for idle battery, at the cost of restarting the app each time the panel is reopened.

In `screencap` mode there is no such state, so capture stops entirely while the view is hidden.

Injected taps only reach an app while the device is awake. Asleep, Android's input dispatcher
cancels them as wake-up gestures, and the symptom is a panel that streams perfectly but ignores
every click -- an app on a virtual display keeps rendering either way, because that display does
not share the physical screen's power state. The keyguard is not involved: awake and locked
delivers input fine. The panel therefore wakes the device when it starts, and again whenever the
health check finds it asleep. `androidPanel.wakeDevice` turns that off, at the cost of a panel
that cannot be clicked once the screen times out.

scrcpy's `keep_active` would stop the timeout from firing at all, and is deliberately not used.
From Android 14, scrcpy creates its virtual display with `FLAG_DEVICE_DISPLAY_GROUP` as well as
`FLAG_OWN_DISPLAY_GROUP`, which puts it in the phone's own display group -- on One UI 8
`dumpsys display` shows `displayGroupId 0` for it -- so reporting activity there would keep the
phone itself from ever locking while the panel runs. Waking it after a timeout leaves it locked.

In `screencap` mode frames are hashed and only pushed when the screen actually changed, so a static
screen costs one `screencap` per interval and nothing else. That mode can only read **physical**
displays: virtual displays are rejected by `screencap` and `screenrecord` alike, which take physical
display IDs only. Use `stream` mode for a virtual display.

## Icons

Two different things, easy to confuse. `contributes.viewsContainers.activitybar[].icon` is the
activity bar glyph: a monochrome SVG that must paint with `currentColor` so it follows the theme and
the selected/unselected state. The top-level `icon` field is the raster image shown in the extensions
list and must be a PNG, so `currentColor` is not available and the artwork carries its own colour.

Both are drawn from the same phone outline, kept at a 24-unit grid so the two stay in step.

## Language

The interface is English, and Korean is used instead when the editor's display language is Korean.
`package.nls.ko.json` covers the settings and command titles, `l10n/bundle.l10n.ko.json` the status
messages and the panel's own buttons. Another language is one more file of each and no code changes.

## Releasing

Tag the release and let the workflow build it:

```
npm version 0.2.3 --no-git-tag-version
git commit -am "release: 0.2.3"
git tag -a v0.2.3 -m "0.2.3"
git push --follow-tags
```

The `-a` matters: `--follow-tags` pushes annotated tags only, so a plain `git tag` is left
behind on the machine and the workflow never fires.

That runs the tests, packages the extension and attaches the `.vsix` to a GitHub release. The
tag has to match `version` in `package.json` or the workflow stops before doing any of it.

Then put that `.vsix` on the Marketplace by hand, through *Manage Publishers & Extensions* →
the extension's `...` menu → *Update*. No credential is involved: the browser session is the
credential. `npm run package` builds the same file locally if you would rather not wait for
the workflow.

### Publishing from CI instead (optional)

A CI runner has no browser session, so it needs a token of its own to prove who it is. Supply
one and the same tag push also publishes; leave it out and that marketplace is skipped without
failing the run. Worth setting up only if releases get frequent enough that the manual upload
grates.

`VSCE_PAT` publishes to the Visual Studio Marketplace. Create it at
<https://dev.azure.com/_usersSettings/tokens>, signed in as the same account that owns the
publisher.

That is Azure DevOps, which is not the Azure portal: `portal.azure.com` is the cloud console
and will ask for a subscription that this does not need. Azure DevOps is free, and being asked
to create an organization on the way in is expected.

Two fields decide whether the token works, and the default is wrong for both:

- **Organization** must be *All accessible organizations*, not the single organization that is
  preselected.
- **Scopes** must be *Custom defined*, then **Marketplace → Manage**. The token cannot be
  read back after the dialog closes.

`OVSX_PAT` publishes to Open VSX, which is what VS Code forks read. Sign in at
<https://open-vsx.org> with GitHub, sign the Eclipse publisher agreement it asks for, then
generate a token under *Settings → Access Tokens*. Open VSX also needs the publisher's
namespace to exist before anything can go into it; the workflow creates it on the first
publish, so there is nothing to do by hand.

Store them without letting either through a shell history or a chat window:

```
gh secret set VSCE_PAT --repo amophi/android-panel
gh secret set OVSX_PAT --repo amophi/android-panel
```

Each command prompts for the value and reads it from the terminal.

## License

MIT
