const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const {
  ScrcpyStream, codecStringFromConfig, ACTION, touchMessage, scrollMessage, keyMessage, resetVideoMessage,
} = require('./scrcpy');

const VIEW_ID = 'androidPanel.screen';

// A sleeping device swallows injected taps as wake-up gestures instead of delivering them to
// the app, so the panel streams fine while nothing responds to a click. Being locked is not
// the problem -- being asleep is.
const KEY_WAKEUP = 'KEYCODE_WAKEUP';

// Screencap mode. A gesture after this long without input wakes the device first, since
// nothing else notices that a screen timeout has put it to sleep.
const IDLE_WAKE_MS = 30000;
// Screencap mode. How long after input the next capture comes, instead of a full interval.
const AFTER_INPUT_MS = 150;

// Servers this panel has started, so a later run can clean up after a crash without touching
// a scrcpy session the user is running alongside it.
const SCIDS_KEY = 'startedScids';

/** User-facing text. English is the source language; l10n/bundle.l10n.*.json overlays translations. */
const t = (message, ...args) => vscode.l10n.t(message, ...args);

/** scrcpy.js reports why a stream ended as a code; anything else is already a message. */
function closeReason(code) {
  switch (code) {
    case 'server-exited': return t('The server on the device exited.');
    case 'stream-corrupt': return t('The stream is corrupt.');
    case 'stream-ended': return t('The stream was interrupted.');
    case 'stream-disabled': return t('The device could not set up the video stream.');
    default: return code || t('The stream was interrupted.');
  }
}

function config() {
  const c = vscode.workspace.getConfiguration('androidPanel');
  return {
    mode: c.get('mode') || 'stream',
    show: c.get('show') === 'app' ? 'app' : 'phone',
    adb: (c.get('adbPath') || '').trim() || RESOLVED.adb || 'adb',
    pkg: (c.get('package') || '').trim(),
    interval: Math.max(150, c.get('intervalMs') || 600),
    serial: (c.get('serial') || '').trim(),
    serverPath: (c.get('scrcpyServerPath') || '').trim() || RESOLVED.serverPath || '',
    version: (c.get('scrcpyVersion') || '').trim(),
    newDisplay: (c.get('newDisplay') || '').trim(),
    maxFps: c.get('maxFps') || 0,
    maxSize: c.get('maxSize') || 0,
    stayAwake: c.get('stayAwake') === true,
    wakeDevice: c.get('wakeDevice') !== false,
    keepAlive: c.get('keepStreamWhenHidden') !== false,
  };
}

// With the settings left empty, adb and scrcpy-server are looked up in the usual places,
// so moving to another machine does not mean typing paths in by hand again.
const RESOLVED = { adb: null, serverPath: null };
const LF = String.fromCharCode(10);

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((res) =>
    execFile(finder, [cmd], { timeout: 5000, windowsHide: true }, (e, out) => {
      if (e) return res(null);
      const first = String(out).split(LF)[0].trim();
      res(first || null);
    })
  );
}

async function ensureResolved() {
  const c = vscode.workspace.getConfiguration('androidPanel');
  const adbSet = (c.get('adbPath') || '').trim();
  const srvSet = (c.get('scrcpyServerPath') || '').trim();
  if ((adbSet || RESOLVED.adb) && (srvSet || RESOLVED.serverPath)) return;

  const dirs = [];
  const add = (d) => { if (d && dirs.indexOf(d) < 0) dirs.push(d); };
  // A scrcpy release keeps adb and scrcpy-server in one folder, so finding either finds both.
  for (const exe of ['scrcpy', 'adb']) {
    const found = await which(exe);
    if (found) add(path.dirname(found));
  }
  if (adbSet) add(path.dirname(adbSet));
  if (srvSet) add(path.dirname(srvSet));
  const home = require('os').homedir();
  add(path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools'));
  add(path.join(process.env.LOCALAPPDATA || '', 'scrcpy'));
  add(path.join(home, 'Android', 'Sdk', 'platform-tools'));
  add(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
  add('/usr/local/bin');
  add('/usr/bin');
  add('/opt/homebrew/bin');

  // A scrcpy release is usually unpacked as a versioned folder, such as scrcpy-win64-v4.1,
  // so any folder with scrcpy in its name is swept one level down.
  for (const d of dirs.slice()) {
    if (path.basename(d).toLowerCase().indexOf('scrcpy') < 0) continue;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) add(path.join(d, e.name));
      }
    } catch (_) {
      /* unreadable, move on */
    }
  }

  if (!adbSet && !RESOLVED.adb) {
    outer: for (const d of dirs) {
      for (const n of ['adb.exe', 'adb']) {
        const f = path.join(d, n);
        if (fs.existsSync(f)) { RESOLVED.adb = f; break outer; }
      }
    }
  }
  if (!srvSet && !RESOLVED.serverPath) {
    for (const d of dirs) {
      const f = path.join(d, 'scrcpy-server');
      if (fs.existsSync(f)) { RESOLVED.serverPath = f; break; }
    }
  }
}

/** Runs adb once. With binary, stdout comes back as a Buffer. */
function adb(bin, args, { binary = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/** An emulator may be attached alongside, so when a package is set, prefer the device that has it. */
async function pickSerial(bin, pkg) {
  const out = await adb(bin, ['devices']);
  const ready = out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
  if (!ready.length) return null;
  ready.sort((a, b) => Number(a.startsWith('emulator-')) - Number(b.startsWith('emulator-')));
  if (!pkg) return ready[0];
  for (const s of ready) {
    try {
      const r = await adb(bin, ['-s', s, 'shell', 'pm', 'path', packageOf(pkg)]);
      if (r.includes('package:')) return s;
    } catch (_) {
      /* try the next device */
    }
  }
  return ready[0];
}

/**
 * The server refuses the connection when the version string and the server jar disagree.
 * With the setting empty, the scrcpy executable next to the server file is asked directly.
 */
const versionCache = new Map();
async function detectVersion(serverPath) {
  if (versionCache.has(serverPath)) return versionCache.get(serverPath);
  const dir = path.dirname(serverPath);
  for (const exe of ['scrcpy.exe', 'scrcpy']) {
    const candidate = path.join(dir, exe);
    if (!fs.existsSync(candidate)) continue;
    try {
      const out = await new Promise((res, rej) =>
        execFile(candidate, ['--version'], { timeout: 10000, windowsHide: true },
          (e, so) => (e ? rej(e) : res(so))));
      const m = /scrcpy\s+([0-9][^\s<]*)/.exec(out);
      if (m) {
        versionCache.set(serverPath, m[1]);
        return m[1];
      }
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Whether the keyguard is up. It only matters in phone mode: there the keyguard is part of
 * what gets mirrored, and no fingerprint can be pressed from the panel. A virtual display is
 * a separate screen the keyguard never covers.
 */
async function isLocked(bin, serial) {
  try {
    const out = await adb(bin, ['-s', serial, 'shell', 'dumpsys', 'window']);
    return out.indexOf('mDreamingLockscreen=true') >= 0;
  } catch (_) {
    return false;
  }
}

/**
 * A virtual display needs a size and a density, and the device's own are the only values
 * guaranteed to match its apps. Getting the density wrong crops the right edge of the screen.
 */
async function deviceDisplaySpec(bin, serial) {
  const [size, density] = await Promise.all([
    adb(bin, ['-s', serial, 'shell', 'wm', 'size']),
    adb(bin, ['-s', serial, 'shell', 'wm', 'density']),
  ]);
  // An override is the value in force; the physical one is only a fallback.
  const pick = (text, what) => {
    const over = new RegExp('Override ' + what + ':\\s*(\\S+)').exec(text);
    const phys = new RegExp('Physical ' + what + ':\\s*(\\S+)').exec(text);
    return (over || phys || [])[1] || null;
  };
  const wh = pick(size, 'size');
  const dpi = pick(density, 'density');
  return wh && dpi && /^\d+x\d+$/.test(wh) && /^\d+$/.test(dpi) ? wh + '/' + dpi : null;
}

// Segments that say nothing about which app this is.
const PACKAGE_NOISE = new Set([
  'com', 'org', 'net', 'io', 'co', 'kr', 'jp', 'cn', 'us', 'de', 'me', 'tv',
  'android', 'google', 'samsung', 'sec', 'apps', 'app', 'mobile', 'client',
  'ad', 'ads', 'free', 'lite', 'main',
]);

/**
 * adb cannot resolve an app's label: labelRes is a resource id and nonLocalizedLabel comes
 * back null for every activity, so a name has to be guessed from the package id.
 *
 * The last segment alone is often the least informative part -- com.mxtech.videoplayer.ad
 * would read as "Ad". Boilerplate and store-code segments are dropped and the longest of
 * what remains is used, which keeps "Videoplayer" and "Chrome" and falls back to the last
 * segment when everything was dropped.
 */
function appName(pkg) {
  const parts = pkg.split('.').filter(Boolean);
  const meaningful = parts.filter((s) => {
    if (PACKAGE_NOISE.has(s.toLowerCase())) return false;
    // Store ids such as A000Z00040 or v2 carry no meaning either.
    return !/\d/.test(s) || /[a-z]{4}/.test(s);
  });
  const pool = meaningful.length ? meaningful : parts;
  const pick = pool.reduce((best, s) => (s.length > best.length ? s : best), '');
  const label = (pick || pkg).replace(/[_-]+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : pkg;
}

/** Every launchable activity on the device, with the user's own apps first. */
async function appList(bin, serial) {
  const out = await adb(bin, ['-s', serial, 'shell', 'cmd', 'package', 'query-activities',
    '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER']);
  const components = [...new Set(out.match(/[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+/g) || [])];
  let installed = new Set();
  try {
    const listed = await adb(bin, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3']);
    installed = new Set(listed.split(/\r?\n/)
      .map((l) => l.replace('package:', '').trim()).filter(Boolean));
  } catch (_) {
    /* ordering only */
  }
  return components
    .map((component) => {
      const pkg = packageOf(component);
      return { component, pkg, name: appName(pkg), user: installed.has(pkg) };
    })
    .sort((a, b) => Number(b.user) - Number(a.user) || a.name.localeCompare(b.name));
}

/** `androidPanel.package` may name a component (`pkg/activity`); this is the package half. */
function packageOf(spec) {
  return spec.split('/')[0];
}

/** Finds a package's launcher activity. Starting it on a virtual display needs the component name. */
async function launcherActivity(bin, serial, pkg) {
  const out = await adb(bin, [
    '-s', serial, 'shell', 'cmd', 'package', 'resolve-activity',
    '--brief', '-c', 'android.intent.category.LAUNCHER', pkg,
  ]);
  const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  return line && line.includes('/') ? line : null;
}

/** Reads the real screen resolution from the PNG header, to map clicks back in screencap mode. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Escapes a value for an HTML attribute. Translated text is text, never markup. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * What the device's `input` command can do. It grew over the years: `motionevent` came with
 * Android 10, its CANCEL with 12, and pointer scrolling only with 14 QPR3 -- partway through an
 * API level, so that one is looked up in the usage text rather than inferred from the version.
 */
async function inputCaps(bin, serial) {
  try {
    const out = await adb(bin, ['-s', serial, 'shell',
      'getprop ro.build.version.sdk; input 2>&1 | grep -c -w scroll; true']);
    const [sdk, scroll] = out.split(/\r?\n/).map((l) => parseInt(l, 10));
    if (!Number.isFinite(sdk)) return null;
    return { motionevent: sdk >= 29, cancel: sdk >= 31, scroll: scroll > 0 };
  } catch (_) {
    return null;
  }
}

/** Tap and swipe, which every Android version has. */
const LEGACY_INPUT = { motionevent: false, cancel: false, scroll: false };

// Without pointer scrolling, a wheel notch becomes a drag of this share of the screen's long
// side -- about the 64 dp a notch scrolls on a phone -- once the turns add up to a drag long
// enough not to be taken for a tap.
const WHEEL_DRAG = 0.07;
const MIN_WHEEL_DRAG = 64;

const TOUCH_EDGES = { down: 'DOWN', move: 'MOVE', up: 'UP', cancel: 'CANCEL' };

/** Adds one wheel event to another that is still waiting to be sent. */
function addScroll(a, b) {
  return a ? Object.assign({}, b, { dx: a.dx + b.dx, dy: a.dy + b.dy }) : Object.assign({}, b);
}

/**
 * The `input` command lines for one event from the webview, for when there is no scrcpy
 * control socket (screencap mode). Positions are already display pixels there: a screencap is
 * taken at full resolution, in the current rotation.
 *
 * Where the device has `motionevent`, a touch goes as one command per edge of the gesture
 * rather than as a tap or a swipe replayed after the fact: the device then sees how long a press
 * was held and where a drag paused, so a hold is a long press and a drag that stops does not
 * fling. Older devices only have tap and swipe, so there the press is kept in `gesture` and
 * replayed on release. An empty list means there is nothing to send for this event.
 */
function adbInputCommands(m, displayId, caps, gesture) {
  const d = displayId === null || displayId === undefined ? '' : ` -d ${displayId}`;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  if (m.type === 'key') return Number.isInteger(m.code) ? [`input${d} keyevent ${m.code}`] : [];
  const x = n(m.x), y = n(m.y);
  if (x === null || y === null) return [];

  if (m.type === 'touch') {
    if (!Object.prototype.hasOwnProperty.call(TOUCH_EDGES, m.action)) return [];
    // A gesture keeps the way it started, even if the device's abilities come in meanwhile.
    if (m.action === 'down') gesture.press = { x, y, t: Date.now(), motion: caps.motionevent, moved: false };
    const press = gesture.press;
    if (!press) return [];
    const last = m.action === 'up' || m.action === 'cancel';
    if (last) gesture.press = null;
    if (press.motion) {
      // Before Android 12 there is no CANCEL, and lifting is the only way to end the touch.
      const edge = m.action === 'cancel' && !caps.cancel ? 'UP' : TOUCH_EDGES[m.action];
      return [`input${d} motionevent ${edge} ${x} ${y}`];
    }
    if (m.action === 'move') press.moved = true;
    if (!last || m.action === 'cancel') return [];
    if (!press.moved) return [`input${d} tap ${press.x} ${press.y}`];
    const ms = Math.min(2000, Math.max(100, Date.now() - press.t));
    return [`input${d} swipe ${press.x} ${press.y} ${x} ${y} ${ms}`];
  }

  if (m.type === 'scroll') {
    if (!Number.isFinite(m.dx) || !Number.isFinite(m.dy)) return [];
    if (caps.scroll) {
      // The source comes before -d; `input` reads its arguments in that order.
      return [`input mouse${d} scroll ${x} ${y} --axis VSCROLL,${m.dy.toFixed(3)} --axis HSCROLL,${m.dx.toFixed(3)}`];
    }
    if (!(m.w > 0 && m.h > 0)) return [];
    const wheel = gesture.wheel || { dx: 0, dy: 0 };
    wheel.dx += m.dx;
    wheel.dy += m.dy;
    gesture.wheel = wheel;
    // Scrolling up moves the content down, which a finger does by dragging down.
    const step = Math.max(m.w, m.h) * WHEEL_DRAG;
    const mx = -wheel.dx * step, my = wheel.dy * step;
    if (Math.hypot(mx, my) < MIN_WHEEL_DRAG) return [];
    gesture.wheel = null;
    const clamp = (v, size) => Math.min(size - 1, Math.max(0, Math.round(v)));
    const x2 = clamp(x + mx, m.w), y2 = clamp(y + my, m.h);
    if (caps.motionevent) {
      // Holding still at the end before lifting leaves the drag no speed to fling with.
      const me = (a, px, py) => `input${d} motionevent ${a} ${px} ${py}`;
      return [[me('DOWN', x, y), me('MOVE', x2, y2), 'sleep 0.15', me('MOVE', x2, y2), me('UP', x2, y2)].join('; ')];
    }
    return [`input${d} swipe ${x} ${y} ${x2} ${y2} 400`];
  }
  return [];
}

const ACK = '__androidPanel_ack__';
// A shell that has not finished a command in this long is taken to be stuck, and replaced.
const STALL_MS = 5000;

/**
 * One long-lived `adb shell` that input commands are written into, a line each. Starting adb
 * for every event costs a process and a handshake each time, and two events in flight can
 * overtake each other; one shell keeps them cheap and in order.
 *
 * Every command echoes a marker when it finishes, so the shell knows how many are still
 * running. Moves arrive faster than `input` can inject them, so while one is running only the
 * newest waiting move is kept. Everything else is sent as it comes. `onIdle` runs whenever the
 * last command has finished, for a caller holding work back until then.
 */
class InputShell {
  constructor(bin, serial, onIdle, spawnFn) {
    this.bin = bin;
    this.serial = serial;
    this.onIdle = onIdle || null;
    this.spawn = spawnFn || spawn;
    this.proc = null;
    this.running = 0;
    this.move = null;
    this.tail = '';
    this.lastProgress = 0;
  }

  get busy() {
    return this.running > 0 || this.move !== null;
  }

  ensure() {
    if (this.proc) return this.proc;
    const proc = this.spawn(this.bin, ['-s', this.serial, 'shell'], { windowsHide: true });
    proc.stdout.on('data', (d) => this.onOutput(String(d)));
    // An `input` that fails complains on stderr. Left unread, that pipe fills, adb stops
    // forwarding anything, and every later command waits behind it for good.
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    const gone = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.running = 0;
      this.move = null;
    };
    proc.on('exit', gone);
    proc.on('error', gone);
    this.proc = proc;
    this.tail = '';
    return proc;
  }

  run(cmd) {
    const now = Date.now();
    if (this.running && now - this.lastProgress > STALL_MS) this.close();
    if (!this.running) this.lastProgress = now;
    this.running++;
    this.ensure().stdin.write(`${cmd}; echo ${ACK}\n`);
  }

  /** A move that has to wait replaces whichever move was already waiting. */
  runMove(cmd) {
    if (this.running) this.move = cmd;
    else this.run(cmd);
  }

  /** A lift carries its own position, so a move still waiting for it has nothing left to add. */
  dropMove() {
    this.move = null;
  }

  onOutput(text) {
    const lines = (this.tail + text).split(/\r?\n/);
    this.tail = lines.pop();
    for (const line of lines) {
      if (line.trim() !== ACK) continue;
      this.running = Math.max(0, this.running - 1);
      this.lastProgress = Date.now();
    }
    if (this.running) return;
    if (this.move) {
      const cmd = this.move;
      this.move = null;
      this.run(cmd);
    } else if (this.onIdle) {
      this.onIdle();
    }
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    this.running = 0;
    this.move = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch (_) {}
    try { proc.kill(); } catch (_) {}
  }
}

class ScreenView {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.timer = null;
    this.serial = null;
    this.lastHash = '';
    this.busy = false;
    this.stream = null;
    this.displayId = null; // virtual display; null means the device's own screen
    this.configPacket = null;
    this.started = false;
    this.health = null;
    this.shell = null; // InputShell, screencap mode only
    this.hurry = false; // screencap mode: capture again soon after the one in progress
    this.lastInput = 0;
    this.lastKeyFrameRequest = 0;
    // The mode of the current run, once it has a device; null while none is running. Input
    // is routed by this rather than by whatever happens to exist yet, so a click in stream
    // mode before the stream is up is dropped instead of leaking out through adb.
    this.mode = null;
    // Moved on by every stop(). A start() still awaiting something when that happens -- a
    // reconnect in the middle of starting -- sees it and goes no further.
    this.gen = 0;
    // Screencap mode: what the device's `input` can do, the press of a gesture in progress,
    // and wheel turns waiting for the shell.
    this.inputCaps = null;
    this.gesture = {};
    this.pendingScroll = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) return this.start();
      // In stream mode, tearing the stream down destroys the virtual display and the app
      // with it. Glancing at another sidebar view should not throw away work in progress,
      // so the stream is left running.
      const c = config();
      if (!(c.mode === 'stream' && c.keepAlive)) this.stop();
    });
    view.onDidDispose(() => this.stop());
    if (view.visible) this.start();
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  status(text, kind) {
    this.post({ type: 'status', text, kind: kind || 'info' });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const gen = this.gen;
    await ensureResolved();
    if (gen !== this.gen) return;
    const c = config();
    this.status(t('Looking for a device…'));
    let serial;
    try {
      serial = c.serial || (await pickSerial(c.adb, c.pkg));
    } catch (_) {
      if (gen !== this.gen) return;
      this.started = false;
      return this.status(t('Could not run adb. Check the path in the settings.'), 'error');
    }
    if (gen !== this.gen) return;
    this.serial = serial;
    if (!this.serial) {
      this.started = false;
      return this.status(t('No device connected. Check the USB connection.'), 'error');
    }
    this.mode = c.mode;
    this.post({ type: 'mode', mode: c.mode });
    await this.wake(true);
    if (gen !== this.gen) return;
    if (c.mode === 'stream') await this.startStream(c, gen);
    else this.startCapture();
  }

  stop() {
    this.gen++;
    this.started = false;
    this.mode = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.health) {
      clearInterval(this.health);
      this.health = null;
    }
    if (this.stream) {
      const gone = this.stream.scid;
      this.stream.stop()
        .then(() => this.forget(gone))
        .catch(() => {});
      this.stream = null;
    }
    if (this.shell) {
      this.shell.close();
      this.shell = null;
    }
    this.gesture = {};
    this.pendingScroll = null;
    this.displayId = null;
    this.configPacket = null;
  }

  /** Drops a scid we have finished cleaning, so the list cannot grow without bound. */
  async forget(scid) {
    const known = this.context.globalState.get(SCIDS_KEY, []);
    if (!known.includes(scid)) return;
    await this.context.globalState.update(SCIDS_KEY, known.filter((s) => s !== scid));
  }

  // ---------- stream mode: virtual display + H.264 ----------

  async startStream(c, gen) {
    if (!c.serverPath) {
      this.started = false;
      return this.status(t('The scrcpyServerPath setting is required.'), 'error');
    }
    let version = c.version;
    if (!version) {
      version = await detectVersion(c.serverPath);
      if (gen !== this.gen) return;
      if (!version) {
        this.started = false;
        return this.status(t('Could not determine the scrcpy version. Set scrcpyVersion manually.'), 'error');
      }
    }
    // The stream and control formats spoken here are 4.x's. An older server frames the video
    // differently, and the result would be garbage rather than an error.
    if (parseInt(version, 10) < 4) {
      this.started = false;
      return this.status(t('scrcpy {0} is too old. The panel needs scrcpy 4.0 or later.', version), 'error');
    }
    // "phone" mirrors the device's own screen; "app" gets a display of its own.
    let newDisplay = null;
    if (c.show === 'app') {
      newDisplay = c.newDisplay || (await deviceDisplaySpec(c.adb, this.serial));
      if (gen !== this.gen) return;
      if (!newDisplay) {
        this.started = false;
        return this.status(t('Could not read the screen size. Set newDisplay instead.'), 'error');
      }
    }
    const known = this.context.globalState.get(SCIDS_KEY, []);
    const s = new ScrcpyStream({
      adb: c.adb,
      serverPath: c.serverPath,
      serial: this.serial,
      version: version,
      newDisplay: newDisplay,
      knownScids: known,
      maxFps: c.maxFps,
      maxSize: c.maxSize,
      stayAwake: c.stayAwake,
      // Not keep_active. It would stop screen timeouts altogether, but even a virtual display
      // sits in the phone's own display group (measured on One UI 8: displayGroupId 0 despite
      // FLAG_OWN_DISPLAY_GROUP), so the phone would stay unlocked for as long as the panel
      // runs. The health check wakes the device after a timeout instead, locked.
    });
    // Events from a stream this run has since let go of are not ours to act on.
    const live = () => this.stream === s;

    s.on('display', async (id) => {
      if (!live()) return;
      this.displayId = id;
      if (c.pkg) await this.launch();
    });
    // A new video size: at the start, and whenever the display rotates. The webview sends
    // input in pixels of the frames it shows, so it has to know which size is current.
    s.on('session', (v) => {
      if (!live()) return;
      this.status(`${this.serial} · ${v.width}x${v.height}`);
      this.post({ type: 'session', w: v.width, h: v.height });
    });
    s.on('packet', (p) => {
      if (!live()) return;
      // A key frame answers any request for one, so the next request is a new one.
      if (p.type !== 'delta') this.lastKeyFrameRequest = 0;
      if (p.type === 'config') {
        this.configPacket = p.data;
        this.post({ type: 'config', codec: codecStringFromConfig(p.data) });
        return;
      }
      // The config packet is prepended to the key frame; a decoder handles it poorly alone.
      const body =
        p.type === 'key' && this.configPacket
          ? Buffer.concat([this.configPacket, p.data])
          : p.data;
      this.post({ type: 'chunk', key: p.type === 'key', data: body.toString('base64') });
    });
    // A logged error is worth showing, but it is not the end of the stream, so it must not
    // blank the picture the way a real failure does. 'closed' covers those.
    s.on('log', (text) => {
      if (live()) this.status(text.split('\n')[0].slice(0, 120), 'warn');
    });
    s.on('closed', (why) => {
      if (!this.started || !live()) return;
      this.status(closeReason(why), 'error');
      // Everything that belonged to this run goes with it: the health check would otherwise
      // keep polling, and a second one would join it on the next start.
      this.stop();
    });

    // From here on stop() knows about the stream and stops it along with everything else.
    this.stream = s;
    // Written down before the server starts: one that dies in between is still ours to clean.
    await this.context.globalState.update(SCIDS_KEY, [...new Set([...known, s.scid])]);
    if (!live()) return;

    try {
      await s.start();
      // A stop() or a reconnect during start() has already let this stream go. Carrying on
      // would leave a health check polling a stream that is gone.
      if (!live()) return s.stop().catch(() => {});
      // cleanupOrphans() has dealt with every earlier scid by now, so ours is the only one
      // left to remember. Without this the list would grow with every crash.
      await this.context.globalState.update(SCIDS_KEY, [s.scid]);
      if (!live()) return;
      this.status(t('{0} · connecting…', this.serial));
      this.warnIfLocked();
      // The display can vanish and the app can be pushed aside, so check in periodically.
      this.health = setInterval(() => this.healthCheck(), 8000);
    } catch (e) {
      if (!live()) return;
      this.status(t('Could not start the stream: {0}', e.message), 'error');
      this.stop();
    }
  }

  /**
   * Wakes the device unless it is already awake. Injected taps only reach a window while the
   * device is awake; asleep, the input dispatcher cancels them. The lock screen is irrelevant,
   * so this never unlocks anything -- awake and locked is enough.
   *
   * @param {boolean} unconditional skip the wakefulness check and just send the key
   */
  async wake(unconditional) {
    const c = config();
    if (!c.wakeDevice || !this.serial) return;
    try {
      if (!unconditional) {
        const power = await adb(c.adb, ['-s', this.serial, 'shell', 'dumpsys', 'power']);
        if (power.indexOf('mWakefulness=Awake') >= 0) return;
      }
      await adb(c.adb, ['-s', this.serial, 'shell', 'input', 'keyevent', KEY_WAKEUP]);
    } catch (_) {
      /* next round */
    }
  }

  /**
   * The stream sometimes stays up while the picture freezes, because the virtual display went
   * away or another app took it over, and a screen timeout can put the device back to sleep,
   * which stops input without stopping the picture. Checking periodically lets the panel put
   * itself back together.
   */
  async healthCheck() {
    if (!this.started || !this.stream) return;
    // A check that outlives its run would report the next run's display as missing.
    const gen = this.gen;
    const gone = () => gen !== this.gen;
    await this.wake(false);
    if (gone() || (await this.warnIfLocked())) return;
    if (gone() || this.displayId === null) return;
    const c = config();
    try {
      const disp = await adb(c.adb, ['-s', this.serial, 'shell', 'dumpsys', 'display']);
      if (gone()) return;
      if (disp.indexOf('displayId=' + this.displayId + ',') < 0) {
        this.status(t('The display disappeared; reconnecting.'), 'error');
        this.stop();
        this.start();
        return;
      }
      if (!c.pkg) return;
      const acts = await adb(c.adb, ['-s', this.serial, 'shell', 'dumpsys', 'activity', 'activities']);
      if (gone()) return;
      const at = acts.indexOf('Display #' + this.displayId + ' ');
      if (at >= 0 && acts.slice(at, at + 800).indexOf(packageOf(c.pkg)) < 0) await this.launch();
    } catch (_) {
      /* look again next round */
    }
  }

  // ---------- screencap mode: polling the device's own screen ----------

  startCapture() {
    this.lastHash = '';
    this.status(this.serial);
    const c = config();
    // Until the answer is in, input is sent the way every Android version understands.
    this.inputCaps = null;
    const gen = this.gen;
    inputCaps(c.adb, this.serial).then((caps) => {
      if (gen === this.gen) this.inputCaps = caps;
    });
    if (c.pkg) this.launch().catch(() => {});
    this.tick();
  }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay === undefined ? config().interval : delay);
  }

  /**
   * Input usually changes the screen, and waiting out the full interval to show it reads as
   * lag. The short delay gives the app a moment to draw its response first.
   */
  captureSoon() {
    if (this.mode !== 'screencap') return;
    this.lastHash = '';
    if (this.busy) this.hurry = true;
    else if (this.started) this.schedule(AFTER_INPUT_MS);
  }

  async tick() {
    if (!this.started || this.mode !== 'screencap') return;
    if (this.busy) return this.schedule();
    this.busy = true;
    try {
      const c = config();
      const png = await adb(c.adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], { binary: true });
      const size = pngSize(png);
      if (!size) throw new Error('could not read the screen');
      // A mostly-text screen rarely changes, so only send what actually differs.
      const hash = crypto.createHash('sha1').update(png).digest('hex');
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.post({ type: 'frame', data: png.toString('base64'), w: size.w, h: size.h });
      }
    } catch (_) {
      this.lastHash = '';
      this.status(t('Could not read the screen. Check the device connection.'), 'error');
    } finally {
      this.busy = false;
      const hurry = this.hurry;
      this.hurry = false;
      this.schedule(hurry ? AFTER_INPUT_MS : undefined);
    }
  }

  // ---------- input ----------

  /** One input event from the webview: a touch, a wheel turn or a key. */
  input(m) {
    if (!this.started || !this.mode) return;
    const now = Date.now();
    const idle = now - this.lastInput;
    this.lastInput = now;
    if (this.mode === 'stream') {
      if (this.stream) this.inputViaControl(m);
      return;
    }
    this.inputViaAdb(m, idle);
  }

  /**
   * Stream mode. The scrcpy server injects the event itself, so there is no process per
   * event, and it maps the position onto the display through its own scaling and rotation.
   * Until the control socket is up there is nothing to send on, and the event is dropped.
   */
  inputViaControl(m) {
    const s = this.stream;
    try {
      if (m.type === 'touch' && Object.prototype.hasOwnProperty.call(ACTION, m.action)) {
        s.control(touchMessage(ACTION[m.action], m));
      } else if (m.type === 'scroll') {
        s.control(scrollMessage(m, m.dx, m.dy));
      } else if (m.type === 'key' && Number.isInteger(m.code)) {
        s.control(keyMessage(ACTION.down, m.code));
        s.control(keyMessage(ACTION.up, m.code));
      }
    } catch (_) {
      /* a malformed position; the next event is independent of it */
    }
  }

  /** Screencap mode, which has no scrcpy server and so no control socket. */
  inputViaAdb(m, idle) {
    const c = config();
    if (!this.shell) this.shell = new InputShell(c.adb, this.serial, () => this.flushScroll());
    const sh = this.shell;
    // A wheel turns faster than `input` can keep up with. While the shell is busy the turns
    // are added up and go as one scroll once it is free, instead of queueing one by one and
    // holding up whatever comes after them.
    if (m.type === 'scroll') {
      if (sh.busy) {
        this.pendingScroll = addScroll(this.pendingScroll, m);
        return;
      }
    } else {
      this.flushScroll(); // a scroll made before this event still goes first
    }
    const cmds = adbInputCommands(m, this.displayId, this.inputCaps || LEGACY_INPUT, this.gesture);
    if (!cmds.length) return;
    if (m.type === 'touch' && m.action === 'move') return sh.runMove(cmds[0]);
    if (m.type === 'touch') sh.dropMove();
    // Nothing checks on the device between captures, so a gesture that starts after a long
    // quiet spell wakes it first. On an awake device the key does nothing.
    if (c.wakeDevice && (m.type !== 'touch' || m.action === 'down') && idle > IDLE_WAKE_MS) {
      sh.run(`input keyevent ${KEY_WAKEUP}`);
    }
    for (const cmd of cmds) sh.run(cmd);
    if (m.type !== 'touch' || m.action === 'up' || m.action === 'cancel') this.captureSoon();
  }

  flushScroll() {
    const m = this.pendingScroll;
    if (!m || !this.shell) return;
    this.pendingScroll = null;
    const cmds = adbInputCommands(m, this.displayId, this.inputCaps || LEGACY_INPUT, this.gesture);
    for (const cmd of cmds) this.shell.run(cmd);
    if (cmds.length) this.captureSoon();
  }

  /**
   * Asks the server for a key frame, when the webview's decoder has lost its place. The
   * webview already asks at most once a second; this only guards against a runaway page,
   * and is kept well short of that so the two limits cannot add up.
   */
  requestKeyFrame() {
    const now = Date.now();
    if (!this.stream || now - this.lastKeyFrameRequest < 250) return;
    this.lastKeyFrameRequest = now;
    this.stream.control(resetVideoMessage());
  }

  async launch() {
    const c = config();
    if (!c.pkg) return;
    try {
      if (this.displayId !== null) {
        // A home app carries no LAUNCHER category, so resolve-activity finds nothing for it.
        // Naming the activity outright is the only way to start one on a virtual display.
        const comp = c.pkg.indexOf('/') >= 0
          ? c.pkg
          : await launcherActivity(c.adb, this.serial, c.pkg);
        if (comp) {
          await adb(c.adb, [
            '-s', this.serial, 'shell', 'am', 'start',
            '--display', String(this.displayId), '-n', comp,
          ]);
          return;
        }
      }
      await adb(c.adb, [
        '-s', this.serial, 'shell', 'monkey', '-p', packageOf(c.pkg),
        '-c', 'android.intent.category.LAUNCHER', '1',
      ]);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Mirroring a locked device shows the keyguard and swallows everything else, including a
   * freshly started app, which reads as the panel being broken. Warn rather than look dead.
   */
  async warnIfLocked() {
    const c = config();
    if (c.show !== 'phone' || !this.serial || !this.started) return false;
    if (!(await isLocked(c.adb, this.serial))) return false;
    this.status(t('The device is locked, so only the lock screen is mirrored. Unlock it on the device, or set androidPanel.show to app.'), 'warn');
    return true;
  }

  async sendApps() {
    if (!this.serial) return this.post({ type: 'apps', list: [] });
    const c = config();
    try {
      this.post({ type: 'apps', list: await appList(c.adb, this.serial) });
    } catch (_) {
      this.post({ type: 'apps', list: [] });
    }
  }

  /** Starting an app from the picker also remembers it, so the panel reopens on it. */
  async startApp(component) {
    if (!component || !this.serial) return;
    const c = config();
    try {
      // Remember it before starting it. The health check relaunches whatever the setting
      // names, so leaving the old value in place lets it undo this within its next round.
      await vscode.workspace.getConfiguration('androidPanel')
        .update('package', component, vscode.ConfigurationTarget.Global);
      const args = ['-s', this.serial, 'shell', 'am', 'start'];
      if (this.displayId !== null) args.push('--display', String(this.displayId));
      await adb(c.adb, [...args, '-n', component]);
      // It started, but behind the keyguard nothing of it can be seen.
      await this.warnIfLocked();
    } catch (_) {
      // The stream is still up and showing what it showed, so this must not blank it.
      this.status(t('Could not start {0}', component), 'warn');
    }
  }

  onMessage(m) {
    switch (m.type) {
      case 'touch':
      case 'scroll':
      case 'key':
        this.input(m);
        break;
      case 'need-key':
        this.requestKeyFrame();
        break;
      case 'launch':
        this.launch();
        break;
      case 'apps':
        this.sendApps();
        break;
      case 'start':
        this.startApp(m.component);
        break;
      case 'reconnect':
        this.stop();
        this.start();
        break;
    }
  }

  html() {
    const nonce = crypto.randomBytes(16).toString('base64');
    // The webview cannot reach l10n.t, so the text is translated here and handed over.
    const ui = {
      back: t('Back'),
      home: t('Home'),
      launch: t('Launch app'),
      reconnect: t('Reconnect'),
      fit: t('Fit to width / show all'),
      apps: t('Choose an app'),
      search: t('Search'),
      noApps: t('No apps found'),
      loading: t('Reading the app list…'),
      waiting: t('Waiting for the device screen…'),
      noWebCodecs: t('This editor does not support WebCodecs. Change mode to screencap in the settings.'),
      decodeError: t('Decoding error: {0}'),
    };
    // Keep '<' out of the JSON so no translation can close the script tag early.
    const uiJson = JSON.stringify(ui).replace(/</g, '\\u003c');
    const csp = [
      "default-src 'none'",
      'img-src data:',
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language || 'en')}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #bar {
    display: flex; gap: 4px; align-items: center;
    padding: 6px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  button {
    font: inherit; padding: 3px 8px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 3px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2)); }
  #status { margin-left: auto; opacity: .7; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
  #status.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); opacity: 1; }
  #wrap { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  #wrap.wide { align-items: flex-start; overflow-y: auto; }
  #screen, #shot {
    max-width: 100%; max-height: 100%; object-fit: contain; cursor: pointer; display: none;
    touch-action: none; user-select: none; -webkit-user-drag: none;
  }
  #wrap.wide #screen, #wrap.wide #shot { width: 100%; height: auto; max-height: none; }
  #empty { opacity: .6; padding: 16px; text-align: center; line-height: 1.6; }
  #picker {
    position: absolute; inset: 0; display: none; flex-direction: column;
    background: var(--vscode-sideBar-background); z-index: 2;
  }
  #picker.open { display: flex; }
  #filter {
    margin: 6px; padding: 4px 6px; font: inherit; flex: 0 0 auto;
    color: var(--vscode-input-foreground, inherit);
    background: var(--vscode-input-background, transparent);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
    border-radius: 3px;
  }
  #list { flex: 1 1 auto; overflow-y: auto; }
  #list div {
    padding: 5px 8px; cursor: pointer; line-height: 1.3;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  #list div:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }
  #list b { font-weight: 600; }
  #list span { display: block; opacity: .55; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" title="${esc(ui.back)}">←</button>
    <button id="home" title="${esc(ui.home)}">⌂</button>
    <button id="app" title="${esc(ui.launch)}">▶</button>
    <button id="again" title="${esc(ui.reconnect)}">↻</button>
    <button id="apps" title="${esc(ui.apps)}">⊞</button>
    <button id="fit" title="${esc(ui.fit)}">⤢</button>
    <span id="status"></span>
  </div>
  <div id="wrap">
    <canvas id="screen"></canvas>
    <img id="shot" alt="">
    <div id="empty">${esc(ui.waiting)}</div>
    <div id="picker">
      <input id="filter" type="text" placeholder="${esc(ui.search)}">
      <div id="list"></div>
    </div>
  </div>
<script nonce="${nonce}">
(function () {
  const S = ${uiJson};
  const vs = acquireVsCodeApi();
  const canvas = document.getElementById('screen');
  const shot = document.getElementById('shot');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const ctx = canvas.getContext('2d');
  // The size of the picture on show, in its own pixels. Input goes out in these pixels with
  // the size attached, and the server maps it onto the display itself -- scaling and rotation
  // included. It ignores a size that is no longer current, which keeps a rotation from
  // sending taps to the wrong place.
  let picture = { w: 0, h: 0 };
  let target = canvas, visible = null;
  let decoder = null, codec = null, ts = 0, waitingKey = true, lastRecovery = 0;
  let lastKeyAsk = 0, keyAnswered = true, failed = false;
  let pending = null, drawQueued = false;
  // Frames the decoder may hold before it counts as falling behind.
  const MAX_QUEUE = 10;

  function show(el) {
    target = el;
    if (visible === el) return; // runs for every frame; touch the DOM only on a change
    visible = el;
    canvas.style.display = el === canvas ? 'block' : 'none';
    shot.style.display = el === shot ? 'block' : 'none';
    empty.style.display = 'none';
  }

  // A failure ends the picture. The frame waiting to be drawn and the decoder go with it, or a
  // late frame would put the canvas back over the message; the next config starts afresh.
  function fail(msg) {
    failed = true;
    if (pending) { pending.close(); pending = null; }
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
    decoder = null;
    visible = null;
    status.textContent = msg; status.className = 'error';
    canvas.style.display = 'none'; shot.style.display = 'none';
    empty.style.display = 'block'; empty.textContent = msg;
  }

  function b64(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Frames are drawn once per display refresh, newest only. Drawing each as it arrives falls
  // behind whenever the device outpaces the panel, and a frame replaced before it was drawn
  // is closed at once, so the decoder is never kept waiting for frames parked here.
  function present(frame) {
    if (pending) pending.close();
    pending = frame;
    if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); }
  }

  function draw() {
    drawQueued = false;
    const frame = pending;
    pending = null;
    if (!frame) return;
    const w = frame.displayWidth, h = frame.displayHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    picture = { w: w, h: h };
    show(canvas);
  }

  // Every frame depends on the one before it, so decoding can only resume from a key frame.
  // The server sends one on request rather than making the panel wait for the next one. Each
  // request restarts the encoder on the device, so one a second is the most that is asked --
  // except that a decoder failing after its key frame came has a new problem, not the old one.
  function needKey(urgent) {
    waitingKey = true;
    const now = Date.now();
    if (!(urgent && keyAnswered) && now - lastKeyAsk < 1000) return;
    lastKeyAsk = now;
    keyAnswered = false;
    vs.postMessage({ type: 'need-key' });
  }

  function setupDecoder(c) {
    if (typeof VideoDecoder === 'undefined') {
      fail(S.noWebCodecs);
      return;
    }
    codec = c;
    failed = false;
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
    waitingKey = true;
    const d = new VideoDecoder({
      // A decoder that has been replaced may still hand over a frame it was working on.
      output: (frame) => (decoder === d ? present(frame) : frame.close()),
      // An error closes the decoder for good, and no new one would come before the next
      // rotation. So a fresh one takes over and asks for a key frame -- unless that already
      // happened a moment ago, which means the stream itself is the problem.
      error: (e) => {
        if (decoder !== d) return;
        const msg = S.decodeError.replace('{0}', e.message);
        const now = Date.now();
        if (now - lastRecovery < 2000) return fail(msg);
        lastRecovery = now;
        status.textContent = msg; status.className = 'error';
        setupDecoder(codec);
        needKey(true);
      },
    });
    d.configure({ codec: c, optimizeForLatency: true });
    decoder = d;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'config') {
      setupDecoder(m.codec);
    } else if (m.type === 'chunk') {
      // Chunks with no decoder to take them: the page was reloaded under a running stream,
      // and the config it needs went past before. A reset sends a new one straight away.
      if (!decoder) {
        if (!failed && typeof VideoDecoder !== 'undefined') needKey();
        return;
      }
      if (decoder.state !== 'configured') return;
      if (m.key) keyAnswered = true;
      if (waitingKey && !m.key) return needKey(); // decoding has to start on a key frame
      // A decoder that cannot keep up only falls further behind, since no frame can be
      // skipped. Starting again from a fresh key frame catches up at once.
      if (!m.key && decoder.decodeQueueSize > MAX_QUEUE) return needKey();
      waitingKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({
          type: m.key ? 'key' : 'delta',
          timestamp: (ts += 16000),
          data: b64(m.data),
        }));
      } catch (err) { needKey(); }
    } else if (m.type === 'session') {
      // The display rotated. A finger still down would be lifted with the old size, which
      // the server now ignores, and stay pressed on the device; it is cancelled with the new
      // size instead. A cancel is not a click, so nothing gets pressed by accident.
      //
      // The server switches sizes a little before it says so, and a lift sent in between is
      // dropped the same way. So a lift from just before is followed by a cancel as well; for
      // a finger that did come up, the cancel changes nothing.
      const recent = !finger && lastTouch && lastTouch.action !== 'down' && lastTouch.action !== 'move'
        && Date.now() - lastTouch.t < 500 ? lastTouch : null;
      const p = finger ? finger.last : recent;
      if (p && (p.w !== m.w || p.h !== m.h)) {
        finger = null;
        pendingMove = null;
        touch('cancel', {
          x: Math.min(m.w - 1, Math.round(p.x * m.w / p.w)),
          y: Math.min(m.h - 1, Math.round(p.y * m.h / p.h)),
          w: m.w, h: m.h,
        });
      }
    } else if (m.type === 'mode') {
      // A new run. The picture still on show belongs to the last one, and input measured
      // against it means nothing now, so none is sent until a frame of this run arrives.
      picture = { w: 0, h: 0 };
      finger = null;
      pendingMove = null;
      wheel = null;
      lastTouch = null;
    } else if (m.type === 'frame') {
      picture = { w: m.w, h: m.h };
      shot.src = 'data:image/png;base64,' + m.data;
      show(shot);
    } else if (m.type === 'apps') {
      apps = m.list || [];
      renderApps();
    } else if (m.type === 'status') {
      status.textContent = m.text;
      status.className = m.kind === 'error' ? 'error' : m.kind === 'warn' ? 'warn' : '';
      status.title = m.text;
      // A warning leaves the picture alone; the device really is showing that.
      if (m.kind === 'error') fail(m.text);
    }
  });

  /**
   * Maps a pointer position to picture pixels. object-fit can leave bars inside the element,
   * so the picture's own rectangle is measured. A press has to land on the picture; a drag
   * that runs off it is held at the edge, the way a finger would stop there.
   */
  function toPicture(e, strict) {
    if (!picture.w) return null;
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const s = Math.min(r.width / picture.w, r.height / picture.h);
    const x = (e.clientX - (r.left + (r.width - picture.w * s) / 2)) / s;
    const y = (e.clientY - (r.top + (r.height - picture.h * s) / 2)) / s;
    if (strict && (x < 0 || y < 0 || x >= picture.w || y >= picture.h)) return null;
    const clamp = (v, n) => Math.min(n - 1, Math.max(0, Math.round(v)));
    return { x: clamp(x, picture.w), y: clamp(y, picture.h), w: picture.w, h: picture.h };
  }

  let lastTouch = null;
  function touch(action, p) {
    lastTouch = { action: action, x: p.x, y: p.y, w: p.w, h: p.h, t: Date.now() };
    vs.postMessage({ type: 'touch', action: action, x: p.x, y: p.y, w: p.w, h: p.h });
  }

  // One finger, worked by the primary button and passed on as it happens: down on press,
  // moves while dragging, up on release. The device sees the real timing, so holding is a
  // long press and a drag that stops before release does not fling. Pointer capture keeps the
  // gesture going when the pointer leaves the picture.
  //
  // Wobble under SLOP CSS pixels keeps a click a click. In landscape one CSS pixel is about
  // ten device pixels, so measuring on the device side would turn a shaky click into a drag.
  const SLOP = 4;
  let finger = null, pendingMove = null, moveQueued = false;

  function press(e) {
    if (e.button !== 0 || finger) return;
    const p = toPicture(e, true);
    if (!p) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    finger = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, last: p };
    touch('down', p);
  }

  function drag(e) {
    if (!finger || e.pointerId !== finger.id) return;
    if (!finger.moved && Math.hypot(e.clientX - finger.x0, e.clientY - finger.y0) < SLOP) return;
    finger.moved = true;
    pendingMove = toPicture(e, false);
    if (pendingMove && !moveQueued) { moveQueued = true; requestAnimationFrame(flushMove); }
  }

  // At most one move per display frame; more would only queue up behind each other.
  function flushMove() {
    moveQueued = false;
    if (!finger || !pendingMove) return;
    finger.last = pendingMove;
    touch('move', pendingMove);
    pendingMove = null;
  }

  function lift(e) {
    if (!finger || e.pointerId !== finger.id) return;
    flushMove();
    // A click lifts where it landed; a drag lifts where the pointer is now.
    const p = (finger.moved && toPicture(e, false)) || finger.last;
    finger = null;
    // Losing the pointer without a release -- the view hid, say -- must not count as a click.
    touch(e.type === 'pointerup' ? 'up' : 'cancel', p);
  }

  // A wheel notch is a scroll of 1.0 on Android: a list moves by the phone's own step and
  // does not fling. Chromium reports a notch as 100 pixels, and touchpads send fractions of
  // one. What arrives within one display frame is added up and sent at once.
  let wheel = null;
  function onWheel(e) {
    e.preventDefault();
    const p = toPicture(e, false);
    if (!p) return;
    const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
    if (!wheel) {
      wheel = { dx: 0, dy: 0 };
      requestAnimationFrame(flushWheel);
    }
    wheel.p = p;
    wheel.dx += e.deltaX / unit;
    wheel.dy -= e.deltaY / unit; // down is positive in the browser and negative on Android
  }

  function flushWheel() {
    const w = wheel;
    wheel = null;
    if (!w || (!w.dx && !w.dy)) return;
    vs.postMessage({ type: 'scroll', x: w.p.x, y: w.p.y, w: w.p.w, h: w.p.h, dx: w.dx, dy: w.dy });
  }

  [canvas, shot].forEach((el) => {
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointermove', drag);
    el.addEventListener('pointerup', lift);
    el.addEventListener('pointercancel', lift);
    el.addEventListener('lostpointercapture', lift);
    el.addEventListener('wheel', onWheel, { passive: false });
  });
  // An image is draggable by default, and a native drag swallows the rest of the gesture.
  shot.draggable = false;

  document.getElementById('back').onclick = () => vs.postMessage({ type: 'key', code: 4 });
  document.getElementById('home').onclick = () => vs.postMessage({ type: 'key', code: 3 });
  document.getElementById('app').onclick = () => vs.postMessage({ type: 'launch' });
  document.getElementById('again').onclick = () => vs.postMessage({ type: 'reconnect' });

  // The app picker. Names come from package ids, so the filter matters more than usual.
  const picker = document.getElementById('picker');
  const filter = document.getElementById('filter');
  const list = document.getElementById('list');
  let apps = null;

  function renderApps() {
    const q = filter.value.trim().toLowerCase();
    list.textContent = '';
    if (apps === null) { list.textContent = S.loading; return; }
    const shown = apps.filter((a) =>
      !q || a.name.toLowerCase().indexOf(q) >= 0 || a.pkg.toLowerCase().indexOf(q) >= 0);
    if (!shown.length) { list.textContent = S.noApps; return; }
    for (const a of shown.slice(0, 300)) {
      const row = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = a.name;
      const s = document.createElement('span');
      s.textContent = a.pkg;
      row.appendChild(b);
      row.appendChild(s);
      row.onclick = () => {
        vs.postMessage({ type: 'start', component: a.component });
        picker.classList.remove('open');
      };
      list.appendChild(row);
    }
  }

  filter.oninput = renderApps;
  filter.onkeydown = (e) => { if (e.key === 'Escape') picker.classList.remove('open'); };
  document.getElementById('apps').onclick = () => {
    const open = picker.classList.toggle('open');
    if (!open) return;
    filter.value = '';
    apps = null;
    renderApps();
    vs.postMessage({ type: 'apps' });
    filter.focus();
  };

  // Fill the sidebar's width and scroll, or shrink until the whole screen fits.
  const wrap = document.getElementById('wrap');
  const saved = vs.getState() || {};
  if (saved.wide) wrap.classList.add('wide');
  document.getElementById('fit').onclick = () => {
    wrap.classList.toggle('wide');
    vs.setState({ wide: wrap.classList.contains('wide') });
  };
}());
</script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new ScreenView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      // Keeping the decoder's state means no wait for a key frame when the view reopens.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('androidPanel.launch', () => provider.launch()),
    vscode.commands.registerCommand('androidPanel.reconnect', () => {
      provider.stop();
      provider.start();
    }),
    { dispose: () => provider.stop() }
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { adbInputCommands, addScroll, InputShell, LEGACY_INPUT } };
