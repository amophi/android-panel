// scrcpy 서버와 직접 말하는 클라이언트.
//
// scrcpy 실행 파일을 거치지 않고, 기기에 scrcpy-server.jar 를 올린 뒤
// adb reverse 터널로 H.264 스트림을 직접 받는다. 그래야 가상 디스플레이를
// 쓸 수 있다. 안드로이드의 screencap/screenrecord 는 물리 디스플레이만
// 찍을 수 있어서, 가상 디스플레이는 이 경로 말고는 화면을 얻을 방법이 없다.
//
// 스트림 형식 (scrcpy 4.1 에서 실측):
//   기기명   64바이트, NUL 채움
//   코덱메타 16바이트 = 코덱id 4 + 미상 4 + 가로 4 + 세로 4
//   프레임   [PTS 8 + 길이 4] + Annex-B 데이터, 반복
//   PTS 상위 비트: bit62 = 설정 패킷(SPS/PPS), bit61 = 키프레임

const net = require('net');
const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');

const DEVICE_NAME_LEN = 64;
const CODEC_META_LEN = 16;
const FRAME_HEADER_LEN = 12;
const FLAG_CONFIG = 0x40000000; // PTS 상위 32비트에서 본 값
const FLAG_KEY = 0x20000000;
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const MAX_PACKET = 16 * 1024 * 1024;

class ScrcpyStream extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.adb           adb 실행 파일 경로
   * @param {string} o.serverPath    scrcpy-server 파일 경로
   * @param {string} o.serial        기기 시리얼
   * @param {string} o.version       scrcpy 버전 문자열 (서버 jar 과 일치해야 한다)
   * @param {string} o.newDisplay    예: "1440x3120/560". 비우면 기기 본체 화면을 비춘다
   * @param {number} o.maxFps        0이면 제한 없음
   */
  constructor(o) {
    super();
    this.o = o;
    this.scid = null;
    this.server = null; // net.Server
    this.socket = null;
    this.proc = null; // adb shell 프로세스
    this.buf = Buffer.alloc(0);
    this.phase = 'meta';
    this.displayId = null;
    this.stopped = false;
  }

  exec(args) {
    return new Promise((res, rej) =>
      execFile(
        this.o.adb,
        ['-s', this.o.serial, ...args],
        { maxBuffer: 1 << 26, windowsHide: true },
        (e, out, err) => (e ? rej(new Error((err || '').trim() || e.message)) : res(out))
      )
    );
  }

  async start() {
    // 서버가 Integer.parseInt(scid, 16) 으로 읽으므로 부호 있는 32비트를 넘으면 안 된다.
    const n = require('crypto').randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    this.scid = n.toString(16).padStart(8, '0');

    await this.exec(['push', this.o.serverPath, REMOTE_JAR]);

    // 포트를 OS가 고르게 한 뒤, 그 포트로 되돌림 터널을 만든다.
    this.server = net.createServer((sock) => this.onSocket(sock));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    const port = this.server.address().port;
    await this.exec(['reverse', `localabstract:scrcpy_${this.scid}`, `tcp:${port}`]);

    const args = [
      '-s', this.o.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', this.o.version,
      `scid=${this.scid}`,
      'log_level=info',
      'audio=false',   // 회사에서 쓰므로 소리는 절대 넘기지 않는다
      'control=false', // 입력은 adb shell input 으로 따로 보낸다
    ];
    if (this.o.newDisplay) args.push(`new_display=${this.o.newDisplay}`);
    if (this.o.maxFps) args.push(`max_fps=${this.o.maxFps}`);

    this.proc = spawn(this.o.adb, args, { windowsHide: true });
    this.proc.stdout.on('data', (d) => this.onServerLog(String(d)));
    this.proc.stderr.on('data', (d) => this.onServerLog(String(d)));
    this.proc.on('exit', () => {
      if (!this.stopped) this.emit('closed', '기기 쪽 서버가 종료되었습니다');
    });
  }

  onServerLog(text) {
    // 가상 디스플레이 id 를 알아야 그쪽으로 탭을 보낼 수 있다.
    const m = /New display: .*?\(id=(\d+)\)/.exec(text);
    if (m) {
      this.displayId = Number(m[1]);
      this.emit('display', this.displayId);
    }
    if (/ERROR/i.test(text)) this.emit('log', text.trim());
  }

  onSocket(sock) {
    if (this.socket) return sock.destroy(); // 영상 소켓 하나만 쓴다
    this.socket = sock;
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.emit('closed', e.message));
    sock.on('close', () => {
      if (!this.stopped) this.emit('closed', '스트림이 끊겼습니다');
    });
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.phase === 'meta') {
        const need = DEVICE_NAME_LEN + CODEC_META_LEN;
        if (this.buf.length < need) return;
        const name = this.buf.subarray(0, DEVICE_NAME_LEN).toString('utf8').replace(/\0.*$/, '');
        const codec = this.buf.subarray(64, 68).toString('utf8');
        const width = this.buf.readUInt32BE(72);
        const height = this.buf.readUInt32BE(76);
        this.buf = this.buf.subarray(need);
        this.phase = 'frame';
        this.emit('meta', { name, codec, width, height });
      } else {
        if (this.buf.length < FRAME_HEADER_LEN) return;
        const hi = this.buf.readUInt32BE(0);
        const len = this.buf.readUInt32BE(8);
        if (len === 0 || len > MAX_PACKET) {
          this.emit('closed', '스트림이 깨졌습니다');
          return this.stop();
        }
        if (this.buf.length < FRAME_HEADER_LEN + len) return;
        const data = this.buf.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len);
        this.buf = this.buf.subarray(FRAME_HEADER_LEN + len);
        const type = hi & FLAG_CONFIG ? 'config' : hi & FLAG_KEY ? 'key' : 'delta';
        this.emit('packet', { type, data });
      }
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.socket) this.socket.destroy(); } catch (_) {}
    try { if (this.server) this.server.close(); } catch (_) {}
    try { if (this.proc) this.proc.kill(); } catch (_) {}
    if (this.scid) {
      await this.exec(['reverse', '--remove', `localabstract:scrcpy_${this.scid}`]).catch(() => {});
    }
  }
}

/** SPS 앞부분에서 WebCodecs 가 요구하는 코덱 문자열을 만든다. 예: avc1.640034 */
function codecStringFromConfig(config) {
  for (let i = 0; i + 8 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 0 && config[i + 3] === 1) {
      if ((config[i + 4] & 0x1f) === 7) {
        const p = config[i + 5], c = config[i + 6], l = config[i + 7];
        const hex = (n) => n.toString(16).padStart(2, '0');
        return `avc1.${hex(p)}${hex(c)}${hex(l)}`;
      }
      i += 4;
    }
  }
  return 'avc1.640034';
}

module.exports = { ScrcpyStream, codecStringFromConfig };
