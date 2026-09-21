const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ScrcpyStream, codecStringFromConfig } = require('./scrcpy');

const VIEW_ID = 'androidPanel.screen';

function config() {
  const c = vscode.workspace.getConfiguration('androidPanel');
  return {
    mode: c.get('mode') || 'stream',
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
    keepAlive: c.get('keepStreamWhenHidden') !== false,
  };
}

// 설정을 비워두면 adb 와 scrcpy-server 를 흔한 위치에서 찾아 쓴다.
// PC 를 옮길 때마다 경로를 손으로 넣지 않아도 되게 하기 위한 것이다.
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
  // scrcpy 배포본은 adb 와 scrcpy-server 를 한 폴더에 담고 있다. 하나를 찾으면 둘 다 찾은 셈이다.
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

  // scrcpy 배포본은 보통 scrcpy-win64-v4.1 같은 버전 폴더째 풀어 쓴다.
  // 이름에 scrcpy 가 들어간 폴더는 바로 아래 한 단계까지 훑는다.
  for (const d of dirs.slice()) {
    if (path.basename(d).toLowerCase().indexOf('scrcpy') < 0) continue;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) add(path.join(d, e.name));
      }
    } catch (_) {
      /* 못 읽으면 넘어간다 */
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

/** adb를 한 번 실행한다. binary면 stdout을 Buffer로 받는다. */
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

/** 에뮬레이터가 같이 붙어 있을 수 있으므로, 패키지가 지정되면 그게 깔린 기기를 고른다. */
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
      const r = await adb(bin, ['-s', s, 'shell', 'pm', 'path', pkg]);
      if (r.includes('package:')) return s;
    } catch (_) {
      /* 다음 기기 */
    }
  }
  return ready[0];
}

/**
 * 서버 jar 과 버전 문자열이 어긋나면 서버가 연결을 거부한다.
 * 설정이 비어 있으면 서버 파일 옆의 scrcpy 실행 파일에게 직접 물어본다.
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
      /* 다음 후보 */
    }
  }
  return null;
}

/** 패키지의 실행 액티비티를 찾는다. 가상 디스플레이로 띄우려면 컴포넌트 이름이 필요하다. */
async function launcherActivity(bin, serial, pkg) {
  const out = await adb(bin, [
    '-s', serial, 'shell', 'cmd', 'package', 'resolve-activity',
    '--brief', '-c', 'android.intent.category.LAUNCHER', pkg,
  ]);
  const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  return line && line.includes('/') ? line : null;
}

/** PNG 헤더에서 실제 화면 해상도를 읽는다. screencap 모드에서 클릭 좌표를 되돌릴 때 쓴다. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
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
    this.displayId = null; // 가상 디스플레이. null이면 기기 본체 화면
    this.configPacket = null;
    this.started = false;
    this.health = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) return this.start();
      // stream 모드에서 스트림을 끊으면 가상 디스플레이가 사라지고 앱도 같이 죽는다.
      // 사이드바에서 잠깐 다른 곳을 봤다고 진행하던 것이 날아가면 안 되므로 살려둔다.
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
    await ensureResolved();
    const c = config();
    this.status('기기를 찾는 중...');
    try {
      this.serial = c.serial || (await pickSerial(c.adb, c.pkg));
    } catch (_) {
      this.started = false;
      return this.status('adb를 실행하지 못했습니다. 설정에서 경로를 확인하세요.', 'error');
    }
    if (!this.serial) {
      this.started = false;
      return this.status('연결된 기기가 없습니다. USB를 확인하세요.', 'error');
    }
    this.post({ type: 'mode', mode: c.mode });
    if (c.mode === 'stream') await this.startStream(c);
    else this.startCapture();
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.health) {
      clearInterval(this.health);
      this.health = null;
    }
    if (this.stream) {
      this.stream.stop().catch(() => {});
      this.stream = null;
    }
    this.displayId = null;
    this.configPacket = null;
  }

  // ---------- stream 모드: 가상 디스플레이 + H.264 ----------

  async startStream(c) {
    if (!c.serverPath) {
      this.started = false;
      return this.status('scrcpyServerPath 설정이 필요합니다.', 'error');
    }
    let version = c.version;
    if (!version) {
      version = await detectVersion(c.serverPath);
      if (!version) {
        this.started = false;
        return this.status('scrcpy 버전을 알아내지 못했습니다. scrcpyVersion 을 직접 넣어주세요.', 'error');
      }
    }
    const s = new ScrcpyStream({
      adb: c.adb,
      serverPath: c.serverPath,
      serial: this.serial,
      version: version,
      newDisplay: c.newDisplay || null,
      maxFps: c.maxFps,
      maxSize: c.maxSize,
      stayAwake: c.stayAwake,
    });
    this.stream = s;

    s.on('display', async (id) => {
      this.displayId = id;
      await this.sendDeviceSize();
      if (c.pkg) await this.launch();
    });
    s.on('meta', (m) => {
      this.status(`${this.serial} · ${m.width}x${m.height}`);
      this.sendDeviceSize();
    });
    s.on('packet', (p) => {
      if (p.type === 'config') {
        this.configPacket = p.data;
        this.post({ type: 'config', codec: codecStringFromConfig(p.data) });
        return;
      }
      // 설정 패킷은 키프레임 앞에 붙여 보낸다. 디코더가 따로 받으면 처리하기 까다롭다.
      const body =
        p.type === 'key' && this.configPacket
          ? Buffer.concat([this.configPacket, p.data])
          : p.data;
      this.post({ type: 'chunk', key: p.type === 'key', data: body.toString('base64') });
    });
    s.on('log', (t) => this.status(t.split('\n')[0].slice(0, 120), 'error'));
    s.on('closed', (why) => {
      if (!this.started) return;
      this.status(why || '스트림이 끊겼습니다', 'error');
      this.started = false;
    });

    try {
      await s.start();
      this.status(`${this.serial} · 연결 중...`);
      // 디스플레이가 사라지거나 앱이 밀려나는 일이 있어 주기적으로 확인한다.
      this.health = setInterval(() => this.healthCheck(), 8000);
    } catch (e) {
      this.started = false;
      this.status('스트림을 시작하지 못했습니다: ' + e.message, 'error');
    }
  }

  /**
   * 터치 좌표는 영상 크기가 아니라 디스플레이 해상도를 따른다.
   * max_size 로 줄여 보내면 둘이 달라지므로 기기에 직접 물어본다.
   */
  async sendDeviceSize() {
    const c = config();
    const args = ['-s', this.serial, 'shell', 'wm', 'size'];
    if (this.displayId !== null) args.push('-d', String(this.displayId));
    try {
      const out = await adb(c.adb, args);
      const lines = out.split(/\r?\n/).filter(Boolean);
      const m = /(\d+)x(\d+)/.exec(lines[lines.length - 1] || '');
      if (m) this.post({ type: 'size', w: Number(m[1]), h: Number(m[2]) });
    } catch (_) {
      /* 다음 기회에 */
    }
  }

  /**
   * 스트림은 살아 있는데 화면만 멈추는 경우가 있다. 가상 디스플레이가
   * 사라졌거나, 다른 앱이 그 디스플레이를 차지한 경우다. 주기적으로 확인해
   * 스스로 되돌린다.
   */
  async healthCheck() {
    if (!this.started || this.displayId === null || !this.stream) return;
    const c = config();
    try {
      const disp = await adb(c.adb, ['-s', this.serial, 'shell', 'dumpsys', 'display']);
      if (disp.indexOf('displayId=' + this.displayId + ',') < 0) {
        this.status('화면이 사라져 다시 연결합니다', 'error');
        this.stop();
        this.start();
        return;
      }
      if (!c.pkg) return;
      const acts = await adb(c.adb, ['-s', this.serial, 'shell', 'dumpsys', 'activity', 'activities']);
      const at = acts.indexOf('Display #' + this.displayId + ' ');
      if (at >= 0 && acts.slice(at, at + 800).indexOf(c.pkg) < 0) await this.launch();
    } catch (_) {
      /* 다음 주기에 다시 본다 */
    }
  }

  // ---------- screencap 모드: 기기 본체 화면 폴링 ----------

  startCapture() {
    this.lastHash = '';
    this.status(this.serial);
    if (config().pkg) this.launch().catch(() => {});
    this.tick();
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), config().interval);
  }

  async tick() {
    if (!this.started) return;
    if (this.busy) return this.schedule();
    this.busy = true;
    try {
      const c = config();
      const png = await adb(c.adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], { binary: true });
      const size = pngSize(png);
      if (!size) throw new Error('화면을 읽지 못했습니다');
      // 텍스트 위주 화면은 대부분 그대로다. 바뀐 것만 보낸다.
      const hash = crypto.createHash('sha1').update(png).digest('hex');
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.post({ type: 'frame', data: png.toString('base64'), w: size.w, h: size.h });
      }
    } catch (_) {
      this.lastHash = '';
      this.status('화면을 읽지 못했습니다. 기기 연결을 확인하세요.', 'error');
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  // ---------- 입력 ----------

  async send(args) {
    if (!this.serial) return;
    const c = config();
    // 가상 디스플레이를 쓰는 중이면 그쪽으로 보내야 한다.
    const target = this.displayId === null ? args : ['-d', String(this.displayId), ...args];
    try {
      await adb(c.adb, ['-s', this.serial, 'shell', 'input', ...target]);
      this.lastHash = '';
    } catch (_) {
      /* 다음 프레임에서 복구 */
    }
  }

  async launch() {
    const c = config();
    if (!c.pkg) return;
    try {
      if (this.displayId !== null) {
        const comp = await launcherActivity(c.adb, this.serial, c.pkg);
        if (comp) {
          await adb(c.adb, [
            '-s', this.serial, 'shell', 'am', 'start',
            '--display', String(this.displayId), '-n', comp,
          ]);
          return;
        }
      }
      await adb(c.adb, [
        '-s', this.serial, 'shell', 'monkey', '-p', c.pkg,
        '-c', 'android.intent.category.LAUNCHER', '1',
      ]);
    } catch (_) {
      /* 무시 */
    }
  }

  onMessage(m) {
    switch (m.type) {
      case 'tap':
        this.send(['tap', String(Math.round(m.x)), String(Math.round(m.y))]);
        break;
      case 'swipe':
        this.send([
          'swipe',
          String(Math.round(m.x1)), String(Math.round(m.y1)),
          String(Math.round(m.x2)), String(Math.round(m.y2)),
          String(m.ms || 150),
        ]);
        break;
      case 'key':
        this.send(['keyevent', String(m.code)]);
        break;
      case 'launch':
        this.launch();
        break;
      case 'reconnect':
        this.stop();
        this.start();
        break;
    }
  }

  html() {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      'img-src data:',
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="ko">
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
  #wrap { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  #wrap.wide { align-items: flex-start; overflow-y: auto; }
  #screen, #shot { max-width: 100%; max-height: 100%; object-fit: contain; cursor: pointer; display: none; }
  #wrap.wide #screen, #wrap.wide #shot { width: 100%; height: auto; max-height: none; }
  #empty { opacity: .6; padding: 16px; text-align: center; line-height: 1.6; }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" title="뒤로">←</button>
    <button id="home" title="홈">⌂</button>
    <button id="app" title="앱 실행">▶</button>
    <button id="again" title="다시 연결">↻</button>
    <button id="fit" title="너비에 맞추기 / 전체 보기">⤢</button>
    <span id="status"></span>
  </div>
  <div id="wrap">
    <canvas id="screen"></canvas>
    <img id="shot" alt="">
    <div id="empty">기기 화면을 기다리는 중…</div>
  </div>
<script nonce="${nonce}">
(function () {
  const vs = acquireVsCodeApi();
  const canvas = document.getElementById('screen');
  const shot = document.getElementById('shot');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const ctx = canvas.getContext('2d');
  let dev = { w: 0, h: 0 };
  let decoder = null, ts = 0, waitingKey = true, target = canvas;

  function show(el) {
    target = el;
    canvas.style.display = el === canvas ? 'block' : 'none';
    shot.style.display = el === shot ? 'block' : 'none';
    empty.style.display = 'none';
  }

  function fail(msg) {
    status.textContent = msg; status.className = 'error';
    canvas.style.display = 'none'; shot.style.display = 'none';
    empty.style.display = 'block'; empty.textContent = msg;
  }

  function b64(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setupDecoder(codec) {
    if (typeof VideoDecoder === 'undefined') {
      fail('이 에디터는 WebCodecs를 지원하지 않습니다. 설정에서 mode를 screencap으로 바꾸세요.');
      return;
    }
    try { if (decoder) decoder.close(); } catch (e) {}
    waitingKey = true;
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        show(canvas);
      },
      error: (e) => fail('디코딩 오류: ' + e.message),
    });
    decoder.configure({ codec: codec, optimizeForLatency: true });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'config') {
      setupDecoder(m.codec);
    } else if (m.type === 'chunk') {
      if (!decoder || decoder.state !== 'configured') return;
      if (waitingKey && !m.key) return;   // 키프레임부터 시작해야 한다
      waitingKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({
          type: m.key ? 'key' : 'delta',
          timestamp: (ts += 16000),
          data: b64(m.data),
        }));
      } catch (err) { waitingKey = true; }
    } else if (m.type === 'frame') {
      dev = { w: m.w, h: m.h };
      shot.src = 'data:image/png;base64,' + m.data;
      show(shot);
    } else if (m.type === 'size') {
      dev = { w: m.w, h: m.h };
    } else if (m.type === 'status') {
      status.textContent = m.text;
      status.className = m.kind === 'error' ? 'error' : '';
      if (m.kind === 'error') fail(m.text);
    }
  });

  // 화면에 보이는 위치를 기기 좌표로 되돌린다.
  function toDevice(ev) {
    const r = target.getBoundingClientRect();
    if (!r.width || !dev.w) return null;
    const x = (ev.clientX - r.left) / r.width * dev.w;
    const y = (ev.clientY - r.top) / r.height * dev.h;
    if (x < 0 || y < 0 || x > dev.w || y > dev.h) return null;
    return { x: x, y: y };
  }

  let down = null;
  function onDown(e) { down = { p: toDevice(e), t: Date.now() }; }
  function onUp(e) {
    const up = toDevice(e);
    if (!down || !down.p || !up) { down = null; return; }
    const dx = up.x - down.p.x, dy = up.y - down.p.y;
    if (Math.hypot(dx, dy) < 12) {
      vs.postMessage({ type: 'tap', x: up.x, y: up.y });
    } else {
      vs.postMessage({ type: 'swipe', x1: down.p.x, y1: down.p.y, x2: up.x, y2: up.y,
                       ms: Math.min(600, Math.max(80, Date.now() - down.t)) });
    }
    down = null;
  }
  let wheelLock = 0;
  function onWheel(e) {
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock || !dev.h) return;
    wheelLock = now + 260;
    const cx = dev.w / 2, cy = dev.h / 2;
    const amount = dev.h * 0.28 * (e.deltaY > 0 ? -1 : 1);
    vs.postMessage({ type: 'swipe', x1: cx, y1: cy, x2: cx, y2: cy + amount, ms: 160 });
  }
  [canvas, shot].forEach((el) => {
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
  });

  document.getElementById('back').onclick = () => vs.postMessage({ type: 'key', code: 4 });
  document.getElementById('home').onclick = () => vs.postMessage({ type: 'key', code: 3 });
  document.getElementById('app').onclick = () => vs.postMessage({ type: 'launch' });
  document.getElementById('again').onclick = () => vs.postMessage({ type: 'reconnect' });

  // 사이드바 폭에 맞춰 꽉 채울지(세로 스크롤), 전체가 보이게 줄일지 고른다.
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
      // 디코더 상태를 유지해야 다시 열 때 키프레임을 기다리지 않는다.
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

module.exports = { activate, deactivate };
