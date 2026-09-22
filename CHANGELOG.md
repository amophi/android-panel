# Changelog

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
