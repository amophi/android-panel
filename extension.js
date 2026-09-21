const vscode = require('vscode');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VIEW_ID = 'androidPanel.screen';

function config() {
  const c = vscode.workspace.getConfiguration('androidPanel');
  return {
    adb: c.get('adbPath') || 'adb',
    pkg: (c.get('package') || '').trim(),
    interval: Math.max(150, c.get('intervalMs') || 600),
    serial: (c.get('serial') || '').trim(),
  };
}

/** adb를 한 번 실행한다. binary면 stdout을 Buffer로 받는다. */
function adb(bin, args, { binary = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        encoding: binary ? 'buffer' : 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout,
        windowsHide: true,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/** 에뮬레이터가 같이 붙어 있을 수 있으므로 실물 기기를, 패키지가 지정되면 그게 깔린 기기를 고른다. */
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

/** PNG 헤더에서 실제 화면 해상도를 읽는다. 클릭 좌표를 되돌릴 때 쓴다. */
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
    this.size = null;
    this.busy = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()));
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
    if (this.timer) return;
    this.lastHash = '';
    const { adb: bin, pkg } = config();
    this.status('기기를 찾는 중...');
    try {
      const wanted = config().serial;
      this.serial = wanted || (await pickSerial(bin, pkg));
    } catch (e) {
      this.status('adb를 실행하지 못했습니다. 설정에서 경로를 확인하세요.', 'error');
      return;
    }
    if (!this.serial) {
      this.status('연결된 기기가 없습니다. USB를 확인하세요.', 'error');
      return;
    }
    this.status(this.serial);
    if (pkg) this.launch().catch(() => {});
    this.tick();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule() {
    this.stop();
    this.timer = setTimeout(() => this.tick(), config().interval);
  }

  async tick() {
    if (this.busy) return this.schedule();
    this.busy = true;
    try {
      const { adb: bin } = config();
      const png = await adb(bin, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
        binary: true,
      });
      const size = pngSize(png);
      if (!size) throw new Error('화면을 읽지 못했습니다');
      this.size = size;
      // 텍스트 위주 화면은 대부분 그대로다. 바뀐 것만 보낸다.
      const hash = crypto.createHash('sha1').update(png).digest('hex');
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.post({ type: 'frame', data: png.toString('base64'), w: size.w, h: size.h });
      }
    } catch (e) {
      this.lastHash = '';
      this.status('화면을 읽지 못했습니다. 기기 연결을 확인하세요.', 'error');
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  async send(args) {
    if (!this.serial) return;
    const { adb: bin } = config();
    try {
      await adb(bin, ['-s', this.serial, 'shell', ...args]);
      this.lastHash = ''; // 다음 프레임은 무조건 보낸다
    } catch (e) {
      /* 무시하고 다음 프레임에서 복구 */
    }
  }

  async launch() {
    const { pkg } = config();
    if (!pkg) return;
    await this.send(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  onMessage(m) {
    switch (m.type) {
      case 'tap':
        this.send(['input', 'tap', String(Math.round(m.x)), String(Math.round(m.y))]);
        break;
      case 'swipe':
        this.send([
          'input', 'swipe',
          String(Math.round(m.x1)), String(Math.round(m.y1)),
          String(Math.round(m.x2)), String(Math.round(m.y2)),
          String(m.ms || 150),
        ]);
        break;
      case 'key':
        this.send(['input', 'keyevent', String(m.code)]);
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

  html(webview) {
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
  #screen { max-width: 100%; max-height: 100%; object-fit: contain; cursor: pointer; display: none; image-rendering: auto; }
  #empty { opacity: .6; padding: 16px; text-align: center; line-height: 1.6; }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" title="뒤로">←</button>
    <button id="home" title="홈">⌂</button>
    <button id="app" title="앱 실행">▶</button>
    <button id="again" title="기기 다시 찾기">↻</button>
    <span id="status"></span>
  </div>
  <div id="wrap">
    <img id="screen" alt="">
    <div id="empty">기기 화면을 기다리는 중…</div>
  </div>
<script nonce="${nonce}">
(function () {
  const vs = acquireVsCodeApi();
  const img = document.getElementById('screen');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  let dev = { w: 0, h: 0 };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'frame') {
      dev = { w: m.w, h: m.h };
      img.src = 'data:image/png;base64,' + m.data;
      img.style.display = 'block';
      empty.style.display = 'none';
    } else if (m.type === 'status') {
      status.textContent = m.text;
      status.className = m.kind === 'error' ? 'error' : '';
      if (m.kind === 'error') { img.style.display = 'none'; empty.style.display = 'block'; empty.textContent = m.text; }
    }
  });

  // 화면에 보이는 위치를 기기 좌표로 되돌린다.
  function toDevice(ev) {
    const r = img.getBoundingClientRect();
    if (!r.width || !dev.w) return null;
    const x = (ev.clientX - r.left) / r.width * dev.w;
    const y = (ev.clientY - r.top) / r.height * dev.h;
    if (x < 0 || y < 0 || x > dev.w || y > dev.h) return null;
    return { x, y };
  }

  let down = null;
  img.addEventListener('mousedown', (e) => { down = { p: toDevice(e), t: Date.now() }; });
  img.addEventListener('mouseup', (e) => {
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
  });

  // 휠로 스크롤
  let wheelLock = 0;
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock || !dev.h) return;
    wheelLock = now + 260;
    const cx = dev.w / 2, cy = dev.h / 2;
    const amount = dev.h * 0.28 * (e.deltaY > 0 ? -1 : 1);
    vs.postMessage({ type: 'swipe', x1: cx, y1: cy, x2: cx, y2: cy + amount, ms: 160 });
  }, { passive: false });

  document.getElementById('back').onclick = () => vs.postMessage({ type: 'key', code: 4 });
  document.getElementById('home').onclick = () => vs.postMessage({ type: 'key', code: 3 });
  document.getElementById('app').onclick = () => vs.postMessage({ type: 'launch' });
  document.getElementById('again').onclick = () => vs.postMessage({ type: 'reconnect' });
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
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('androidPanel.launch', () => provider.launch()),
    vscode.commands.registerCommand('androidPanel.reconnect', () => {
      provider.stop();
      provider.start();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
