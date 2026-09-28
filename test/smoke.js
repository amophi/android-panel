// Checks that the webview page builds and that translations reach it without breaking it.
// No framework and no dependencies: run it with `node test/smoke.js`.
//
// The `vscode` module is stubbed, so this drives the real html() rather than a copy of it.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const properties = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  .contributes.configuration.properties;

let provider = null;

/** Stands in for the `vscode` module. `overrides` poisons individual translations. */
function stubVscode(language, overrides) {
  const bundle = Object.assign(
    language === 'ko'
      ? JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.ko.json'), 'utf8'))
      : {},
    overrides || {}
  );
  return {
    env: { language: language },
    l10n: {
      t(message, ...args) {
        let s = bundle[message] || message;
        args.forEach((a, i) => { s = s.split('{' + i + '}').join(String(a)); });
        return s;
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key) => properties['androidPanel.' + key] && properties['androidPanel.' + key].default,
      }),
    },
    window: {
      registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; },
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
  };
}

/** Loads extension.js against the stub and returns the page it would show. */
function page(language, overrides) {
  provider = null;
  const stub = stubVscode(language, overrides);
  const load = Module._load;
  Module._load = function (request) {
    return request === 'vscode' ? stub : load.apply(this, arguments);
  };
  try {
    delete require.cache[path.join(ROOT, 'extension.js')];
    delete require.cache[path.join(ROOT, 'scrcpy.js')];
    const store = {};
    require(path.join(ROOT, 'extension.js')).activate({
      subscriptions: [],
      globalState: {
        get: (k, d) => (k in store ? store[k] : d),
        update: async (k, v) => { store[k] = v; },
      },
    });
    return provider.html();
  } finally {
    Module._load = load;
  }
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail ? '  -> ' + detail : ''));
  if (!ok) failed++;
}

const EXPECTED = {
  en: ['Back', 'Home', 'Launch app', 'Reconnect', 'Waiting for the device screen'],
  ko: ['뒤로', '홈', '앱 실행', '다시 연결', '기기 화면을 기다리는 중'],
};

for (const language of ['en', 'ko']) {
  console.log('language ' + language);
  const html = page(language);
  check('the page builds', html.length > 2000);
  check('the lang attribute follows the editor', html.indexOf('<html lang="' + language + '">') >= 0);
  check('the script carries a CSP nonce', /script-src 'nonce-[^']+'/.test(html));
  for (const text of EXPECTED[language]) {
    check('shows ' + JSON.stringify(text), html.indexOf(text) >= 0);
  }

  const table = /const S = (\{.*?\});/.exec(html);
  check('the string table is injected', !!table);
  if (table) {
    let parsed = null;
    try { parsed = JSON.parse(table[1]); } catch (_) { /* the next check reports it */ }
    check('the string table is valid JSON', !!parsed);
    check('it holds every webview string', parsed && Object.keys(parsed).length === 12,
      parsed && Object.keys(parsed).length + ' keys');
  }
  check('the decoder error keeps its placeholder', /decodeError[^,]*\{0\}/.test(html));
  // The page script lives in a template string, where nothing else would catch a syntax error.
  const body = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  let parses = false, why = '';
  try { new vm.Script(body[1]); parses = true; } catch (e) { why = e.message; }
  check('the page script parses', parses, why);
  console.log('');
}

// Translated text is text. One carrying markup must not break out of the page.
const markup = '</scr' + 'ipt><img src=x onerror=alert(1)>';
const poisoned = page('en', { Back: markup, 'Waiting for the device screen…': markup });
const script = poisoned.slice(poisoned.indexOf('<script nonce'));
check('a translation cannot close the script tag', script.split('</scr' + 'ipt>').length - 1 === 1);
check('a translation leaves no raw < in the string table',
  /const S = (\{.*?\});/.exec(poisoned)[1].indexOf('<') < 0);
check('a translation in an attribute is escaped', poisoned.indexOf('title="</scr' + 'ipt>') < 0);
check('a translation in body text is escaped', poisoned.indexOf('&lt;/scr' + 'ipt&gt;') >= 0);
console.log('');

// A t() call with no Korean entry would leave the panel half-translated.
const source = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
const used = [...new Set([...source.matchAll(/(?<![A-Za-z0-9_.])t\('([^']*)'/g)].map((m) => m[1]))];
const korean = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.ko.json'), 'utf8'));
const untranslated = used.filter((k) => !(k in korean));
const stale = Object.keys(korean).filter((k) => !used.includes(k));
check('every t() string has a Korean entry', untranslated.length === 0, untranslated.join(' | '));
check('the Korean bundle has no stale entries', stale.length === 0, stale.join(' | '));

// A %placeholder% with no entry ships literally, braces and all, into the settings UI.
const nls = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
const nlsKo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.ko.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const placeholders = [...new Set([...manifest.matchAll(/%([A-Za-z0-9._]+)%/g)].map((m) => m[1]))];
check('every %placeholder% is in package.nls.json', placeholders.every((k) => k in nls),
  placeholders.filter((k) => !(k in nls)).join(' | '));
check('the Korean manifest strings match key for key',
  Object.keys(nls).sort().join() === Object.keys(nlsKo).sort().join());

console.log('');

// Control messages, byte for byte against scrcpy 4.1's own serializer tests
// (app/tests/test_control_msg_serialize.c). A wrong byte here and the server either drops the
// event silently or, for an unknown type, shuts down.
const S = require(path.join(ROOT, 'scrcpy.js'));
const hex = (b) => Buffer.from(b).toString('hex');
check('a key matches scrcpy', hex(S.keyMessage(1, 66, 5, 0x41)) === '0001000000420000000500000041');
check('a touch matches scrcpy',
  hex(S.touchMessage(0, { x: 100, y: 200, w: 1080, h: 1920 },
    { pointerId: 0x1234567887654321n, pressure: 1, actionButton: 1, buttons: 1 }))
    === '0200123456788765432100000064000000c804380780ffff0000000100000001');
check('a scroll matches scrcpy',
  hex(S.scrollMessage({ x: 260, y: 1026, w: 1080, h: 1920 }, 16, -16, 1))
    === '030000010400000402043807807fff800000000001');
check('a reset asks for a key frame', hex(S.resetVideoMessage()) === '11');
const drag = hex(S.touchMessage(S.ACTION.move, { x: 1, y: 2, w: 3, h: 4 }));
check('a touch is a finger, not the mouse', drag.slice(4, 20) === 'fffffffffffffffe', drag.slice(4, 20));
check('a pressed finger has full pressure', drag.slice(44, 48) === 'ffff');
for (const action of ['up', 'cancel']) {
  const b = hex(S.touchMessage(S.ACTION[action], { x: 1, y: 2, w: 3, h: 4 }));
  check('a finger ' + action + ' has no pressure', b.slice(44, 48) === '0000');
}
check('a cancel is MotionEvent.ACTION_CANCEL', S.ACTION.cancel === 3);
check('one notch down is -1/16 in fixed point',
  hex(S.scrollMessage({ x: 0, y: 0, w: 1, h: 1 }, 0, -1)).slice(30, 34) === 'f800');
check('a scroll past 16 notches is clamped',
  hex(S.scrollMessage({ x: 0, y: 0, w: 1, h: 1 }, 99, -99)).slice(26, 34) === '7fff8000');
console.log('');

// The video stream, including a rotation part way through. scrcpy 4 marks a size change with a
// bare 12-byte session header; reading its height as a payload length used to derail the whole
// stream, which is what broke landscape games. Chunked every which way, since TCP may split
// anything anywhere.
const session = (w, h) => {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(0x80000000, 0);
  b.writeUInt32BE(w, 4);
  b.writeUInt32BE(h, 8);
  return b;
};
const media = (hi, n) => {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(hi, 0);
  b.writeUInt32BE(n, 8);
  return Buffer.concat([b, Buffer.alloc(n, 7)]);
};
const name = Buffer.alloc(64);
name.write('SM-S936N');
const wire = Buffer.concat([name, Buffer.from('h264'), session(498, 1080),
  media(0x40000000, 33), media(0x20000039, 4000), media(0x00000039, 300),
  session(1080, 498), media(0x40000000, 33), media(0x20000039, 4000), media(0x00000039, 9)]);
const expected = 'M:SM-S936N/h264,S498x1080,c33,k4000,d300,S1080x498,c33,k4000,d9';
for (const step of [1, 7, 12, 4096, wire.length]) {
  const s = new S.ScrcpyStream({});
  s.stop = async () => {}; // a test never reaches adb
  const seen = [];
  s.on('meta', (m) => seen.push('M:' + m.name + '/' + m.codec));
  s.on('session', (v) => seen.push('S' + v.width + 'x' + v.height));
  s.on('packet', (p) => seen.push(p.type[0] + p.data.length));
  s.on('closed', (why) => seen.push('X:' + why));
  for (let i = 0; i < wire.length; i += step) s.onData(wire.subarray(i, i + step));
  check('a rotation survives ' + step + '-byte chunks', seen.join() === expected, seen.join());
}
{
  const s = new S.ScrcpyStream({});
  s.stop = async () => {};
  const seen = [];
  s.on('closed', (why) => seen.push(why));
  s.onData(Buffer.concat([name, Buffer.alloc(4)]));
  check('a disabled stream is reported, not parsed', seen.join() === 'stream-disabled', seen.join());
}
{
  // Before the first session the server has no mapping for positions and would inject them raw.
  const s = new S.ScrcpyStream({});
  const sent = [];
  s.controlSocket = { destroyed: false, write: (b) => sent.push(b[0]) };
  const p = { x: 1, y: 2, w: 3, h: 4 };
  const early = [s.control(S.touchMessage(0, p)), s.control(S.scrollMessage(p, 0, 1)), s.control(S.keyMessage(0, 4))];
  check('no touch or scroll goes out before the first session', early.join() === 'false,false,true', early.join());
  s.onData(Buffer.concat([name, Buffer.from('h264'), session(3, 4)]));
  check('after it they do', s.control(S.touchMessage(0, p)) && sent.join() === '0,2', sent.join());
}
{
  // The display id arrives in a log line, and output can split a line anywhere.
  const s = new S.ScrcpyStream({});
  const ids = [];
  s.on('display', (id) => ids.push(id));
  s.onServerLog('[server] INFO: New disp');
  s.onServerLog('lay: 1440x3120/560 (id=12)\n');
  check('a display id split across chunks is still found', ids.join() === '12', ids.join());
}
console.log('');

// Screencap mode has no control socket and goes through `adb shell input`, whose commands
// depend on the Android version: motionevent from 10, its CANCEL from 12, scroll from 14 QPR3.
const { adbInputCommands, addScroll, InputShell, LEGACY_INPUT } = require(path.join(ROOT, 'extension.js'))._test;
const MODERN = { motionevent: true, cancel: true, scroll: true };
const ANDROID_10 = { motionevent: true, cancel: false, scroll: false };
const cmds = (caps, events, displayId) => {
  const gesture = {};
  return events.map((m) => adbInputCommands(m, displayId === undefined ? null : displayId, caps, gesture).join(' | '));
};
const T = (action, x, y) => ({ type: 'touch', action, x, y, w: 1440, h: 3120 });
check('a press is a motionevent', cmds(MODERN, [T('down', 10.4, 20.6)])[0] === 'input motionevent DOWN 10 21');
check('input is aimed at the display in use',
  cmds(MODERN, [T('down', 1, 2), T('up', 1, 2)], 9)[1] === 'input -d 9 motionevent UP 1 2');
check('a wheel is a mouse scroll, source before display',
  cmds(MODERN, [{ type: 'scroll', x: 5, y: 6, w: 1440, h: 3120, dx: 0, dy: -1 }], 9)[0]
    === 'input mouse -d 9 scroll 5 6 --axis VSCROLL,-1.000 --axis HSCROLL,0.000');
check('a key is a keyevent', cmds(LEGACY_INPUT, [{ type: 'key', code: 4 }])[0] === 'input keyevent 4');
check('before Android 12 a cancel lifts instead',
  cmds(ANDROID_10, [T('down', 5, 5), T('cancel', 6, 6)])[1] === 'input motionevent UP 6 6');
{
  const tap = cmds(LEGACY_INPUT, [T('down', 100, 200), T('up', 101, 201)]);
  check('without motionevent a click is a tap where it landed', tap.join() === ',input tap 100 200', tap.join());
  const drag = cmds(LEGACY_INPUT, [T('down', 100, 200), T('move', 100, 400), T('up', 100, 600)]);
  check('without motionevent a drag is a swipe on release',
    drag[0] === '' && drag[1] === '' && /^input swipe 100 200 100 600 \d+$/.test(drag[2]), drag.join(' / '));
  const cancelled = cmds(LEGACY_INPUT, [T('down', 1, 2), T('cancel', 1, 2)]);
  check('without motionevent a cancel sends nothing', cancelled.join() === ',', cancelled.join());
  const upgraded = {};
  const mixed = [adbInputCommands(T('down', 1, 2), null, LEGACY_INPUT, upgraded),
    adbInputCommands(T('up', 3, 4), null, MODERN, upgraded)].map((c) => c.join());
  check('a gesture keeps the commands it started with', mixed.join('/') === '/input tap 1 2', mixed.join('/'));
}
{
  const S1 = (dy) => ({ type: 'scroll', x: 700, y: 1500, w: 1440, h: 3120, dx: 0, dy });
  const small = cmds(ANDROID_10, [S1(-0.1), S1(-0.1)]);
  check('without scroll, a touchpad trickle waits until it makes a real drag', small.join() === ',', small.join());
  const notch = cmds(ANDROID_10, [S1(-1)])[0];
  check('without scroll, a notch down is a drag up that holds still before lifting',
    notch === 'input motionevent DOWN 700 1500; input motionevent MOVE 700 1282; sleep 0.15; '
      + 'input motionevent MOVE 700 1282; input motionevent UP 700 1282', notch);
  check('without motionevent either, a notch is a slow swipe',
    cmds(LEGACY_INPUT, [S1(1)])[0] === 'input swipe 700 1500 700 1718 400');
}
check('wheel turns add up while the shell is busy',
  JSON.stringify(addScroll(addScroll(null, { x: 1, dx: 0, dy: -1 }), { x: 2, dx: 0.5, dy: -0.5 }))
    === '{"x":2,"dx":0.5,"dy":-1.5}');
check('nothing unknown reaches the shell',
  cmds(MODERN, [{ type: 'touch', action: 'rm -rf', x: 1, y: 2 }]).join() === ''
  && cmds(MODERN, [T('down', '1; reboot', 2)]).join() === ''
  && cmds(MODERN, [{ type: 'key', code: '4; reboot' }]).join() === ''
  && cmds(MODERN, [{ type: 'scroll', x: 1, y: 2, dx: 0, dy: '1; reboot' }]).join() === ''
  && cmds(MODERN, [{ type: 'touch', action: 'toString', x: 1, y: 2 }]).join() === '');

// The shell, against a fake adb: one move in flight, stderr drained, and a stuck shell replaced.
{
  const { EventEmitter } = require('events');
  const spawned = [];
  const fake = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.written = [];
    p.stdin = { write: (s) => p.written.push(s), end() {}, on() {} };
    p.kill = () => {};
    spawned.push(p);
    return p;
  };
  let idle = 0;
  const sh = new InputShell('adb', 'X', () => idle++, fake);
  sh.run('input motionevent DOWN 1 1');
  for (let i = 0; i < 30; i++) sh.runMove('input motionevent MOVE ' + i + ' 1');
  const p = spawned[0];
  check('moves wait while a command runs', p.written.length === 1 && sh.busy, p.written.length);
  p.stdout.emit('data', '__androidPanel_');
  p.stdout.emit('data', 'ack__\n');
  check('only the newest waiting move goes out', p.written.length === 2 && /MOVE 29 1/.test(p.written[1]),
    p.written.join(' | '));
  p.stdout.emit('data', '__androidPanel_ack__\n');
  check('an idle shell says so', idle === 1 && !sh.busy, idle);
  check('stderr is read, so errors cannot back the shell up', p.stderr.listenerCount('data') === 1);
  sh.run('input keyevent 4');
  sh.lastProgress -= 6000;
  sh.run('input keyevent 3');
  check('a shell that stopped answering is replaced', spawned.length === 2 && spawned[1].written.length === 1,
    spawned.length);
  sh.close();
}

console.log('');
console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
