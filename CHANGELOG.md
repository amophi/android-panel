# Changelog

## 0.1.2

- `androidPanel.package` now accepts a component (`package/activity`) and starts it as given.
  A home app registers no launcher entry, so a package name alone resolves to nothing and the
  device's own launcher could not be started. Naming it outright fills a virtual display with
  the real home screen and every app on it, which is what makes the panel usable as a phone
  rather than as a window onto one app.

## 0.1.1

- Wake the device when the panel starts, and again if a screen timeout puts it back to sleep.
  A sleeping device swallows injected taps instead of delivering them to the app, so the panel
  streamed fine while nothing responded to a click -- an app on a virtual display keeps
  rendering, because the display is independent of the physical screen's power state. Being
  locked was never the problem. Set `androidPanel.wakeDevice` to `false` to keep the device
  untouched.
- The health check now also runs while mirroring the device's own screen; it previously did
  nothing at all unless a virtual display was in use.

## 0.1.0

First release.

- Sidebar panel that mirrors a connected Android device and drives it with the mouse.
- `stream` mode speaks the scrcpy server protocol directly: it pushes `scrcpy-server` to the
  device, opens an `adb reverse` tunnel, and decodes the H.264 stream in the webview with
  WebCodecs. That is what makes mirroring a **virtual display** possible, so the device's real
  screen stays free for something else.
- `screencap` mode polls `adb exec-out screencap` instead, for setups without scrcpy. Frames are
  hashed and only pushed when the screen actually changed.
- Clicks, drags and wheel scrolls go back to the device as `input tap` / `input swipe`.
- `adb` and `scrcpy-server` are discovered automatically when their settings are left empty.
- The scrcpy version is read from the `scrcpy` binary next to the server file, so upgrading scrcpy
  does not silently break the panel.
- Leaked servers and `scrcpy_*` reverse tunnels are swept at startup and killed at shutdown, and a
  health check restarts the stream if the virtual display or the configured app goes away.
- English interface, with Korean used when the editor's display language is Korean.
