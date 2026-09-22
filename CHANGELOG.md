# Changelog

## 0.2.0

- The panel is now two explicit modes, chosen with `androidPanel.show`. `phone` mirrors the
  device's own screen: the whole phone, but the keyguard is mirrored too, so it has to be
  unlocked by hand once. `app` gives one app a display of its own and leaves the real screen
  free, which works while the device stays locked. Previously the two were distinguished only
  by whether `newDisplay` happened to be set.
- In `app` mode an empty `newDisplay` is derived from the device's own size and density,
  preferring an override density over the physical one. Hand-written values were the usual
  cause of a cropped right edge.
- The panel has an app button. It lists every launchable activity on the device, filters as
  you type, starts the chosen app on the display in use and remembers it. adb cannot resolve
  an app's label -- `labelRes` is a resource id and `nonLocalizedLabel` is null for every
  activity -- so names are guessed from the package id, with the id shown alongside.

## 0.1.2

- `androidPanel.package` now accepts a component (`package/activity`) and starts it as given,
  for an activity that registers no launcher entry and so cannot be resolved from a package
  name alone.
- Documented what a virtual display can and cannot show. A device's own launcher is not a way
  to get a whole phone onto one: One UI's launcher becomes the resumed activity but paints only
  the wallpaper there, and the vendor's secondary launcher carries a handful of apps. Mirroring
  the real display is the only way to drive the whole phone, and that needs it unlocked.

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
