// Checks that the webview page builds and that translations reach it without breaking it.
// No framework and no dependencies: run it with `node test/smoke.js`.
//
// The `vscode` module is stubbed, so this drives the real html() rather than a copy of it.

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
    require(path.join(ROOT, 'extension.js')).activate({ subscriptions: [] });
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
    check('it holds every webview string', parsed && Object.keys(parsed).length === 8,
      parsed && Object.keys(parsed).length + ' keys');
  }
  check('the decoder error keeps its placeholder', /decodeError[^,]*\{0\}/.test(html));
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
console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
