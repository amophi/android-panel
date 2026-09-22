// A client that speaks to the scrcpy server directly.
//
// Rather than going through the scrcpy executable, this pushes scrcpy-server.jar to the
// device and takes the H.264 stream straight off an adb reverse tunnel. That is what makes
// a virtual display usable: Android's screencap and screenrecord can only capture physical
// displays, so for a virtual display there is no other way to get at the picture.
//
// Stream format (measured against scrcpy 4.1):
//   device name  64 bytes, NUL-padded
//   codec meta   16 bytes = codec id 4 + unknown 4 + width 4 + height 4
//   frames       [PTS 8 + length 4] + Annex-B data, repeated
//   high bits of the PTS: bit62 = config packet (SPS/PPS), bit61 = key frame

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');

const DEVICE_NAME_LEN = 64;
const CODEC_META_LEN = 16;
const FRAME_HEADER_LEN = 12;
const FLAG_CONFIG = 0x40000000; // as seen in the high 32 bits of the PTS
const FLAG_KEY = 0x20000000;
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const SERVER_CLASS = 'com.genymobile.scrcpy.Server';
const MAX_PACKET = 16 * 1024 * 1024;

// The 'closed' event carries a reason code ('server-exited', 'stream-ended',
// 'stream-corrupt') or, for socket errors, the raw message. The caller turns the
// codes into localized text, so this file stays free of vscode and of UI strings.
//
// `scid` names one server and is generated in the constructor rather than in start(), so the
// caller can write it down before anything is running. Cleanup only ever touches scids it was
// handed: another scrcpy session on the same device is none of our business.
class ScrcpyStream extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.adb           path to the adb executable
   * @param {string} o.serverPath    path to the scrcpy-server file
   * @param {string} o.serial        device serial
   * @param {string} o.version       scrcpy version string (must match the server jar)
   * @param {string} o.newDisplay    e.g. "1440x3120/560". Empty mirrors the device's own screen
   * @param {number} o.maxFps        0 for no cap
   * @param {number} o.maxSize       cap on the encoded long edge; scaling on the device lowers the load
   * @param {boolean} o.stayAwake    keep the device from sleeping while it charges
   * @param {string[]} o.knownScids  scids this client started before; the only ones it cleans
   */
  constructor(o) {
    super();
    this.o = o;
    // The server reads this with Integer.parseInt(scid, 16), so it must fit a signed 32-bit int.
    this.scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff)
      .toString(16).padStart(8, '0');
    this.server = null; // net.Server
    this.socket = null;
    this.proc = null; // the adb shell process
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

  /**
   * Clears away the servers and tunnels our own earlier runs left behind.
   * A surviving server keeps an unused virtual display alive, and the next run then puts the
   * app on the wrong display, leaving the panel showing an empty secondary launcher.
   *
   * Only the scids in `knownScids` are touched. Sweeping every server and every scrcpy_*
   * tunnel would also take out a scrcpy session the user is running alongside the panel.
   */
  async cleanupOrphans() {
    for (const scid of this.o.knownScids || []) {
      if (scid === this.scid) continue;
      await this.exec(['shell', 'pkill', '-f', `scid=${scid}`]).catch(() => {});
      await this.exec(['reverse', '--remove', `localabstract:scrcpy_${scid}`]).catch(() => {});
    }
  }

  async start() {
    await this.cleanupOrphans();
    await this.exec(['push', this.o.serverPath, REMOTE_JAR]);

    // Let the OS pick the port, then aim the reverse tunnel at it.
    this.server = net.createServer((sock) => this.onSocket(sock));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    const port = this.server.address().port;
    await this.exec(['reverse', `localabstract:scrcpy_${this.scid}`, `tcp:${port}`]);

    const args = [
      '-s', this.o.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process', '/', SERVER_CLASS, this.o.version,
      `scid=${this.scid}`,
      'log_level=info',
      'audio=false',   // used at work, so audio never leaves the device
      'control=false', // input goes separately, via adb shell input
    ];
    if (this.o.newDisplay) args.push(`new_display=${this.o.newDisplay}`);
    if (this.o.maxFps) args.push(`max_fps=${this.o.maxFps}`);
    if (this.o.maxSize) args.push(`max_size=${this.o.maxSize}`);
    if (this.o.stayAwake) args.push('stay_awake=true');

    this.proc = spawn(this.o.adb, args, { windowsHide: true });
    this.proc.stdout.on('data', (d) => this.onServerLog(String(d)));
    this.proc.stderr.on('data', (d) => this.onServerLog(String(d)));
    this.proc.on('exit', () => {
      if (!this.stopped) this.emit('closed', 'server-exited');
    });
  }

  onServerLog(text) {
    // Taps can only be aimed at the virtual display once its id is known.
    const m = /New display: .*?\(id=(\d+)\)/.exec(text);
    if (m) {
      this.displayId = Number(m[1]);
      this.emit('display', this.displayId);
    }
    if (/ERROR/i.test(text)) this.emit('log', text.trim());
  }

  onSocket(sock) {
    if (this.socket) return sock.destroy(); // only one video socket is used
    this.socket = sock;
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.emit('closed', e.message));
    sock.on('close', () => {
      if (!this.stopped) this.emit('closed', 'stream-ended');
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
          this.emit('closed', 'stream-corrupt');
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
      // Killing the local adb shell leaves the server on the device running. It has to be
      // ended directly for the virtual display to go away.
      await this.exec(['shell', 'pkill', '-f', `scid=${this.scid}`]).catch(() => {});
      await this.exec(['reverse', '--remove', `localabstract:scrcpy_${this.scid}`]).catch(() => {});
    }
  }
}

/** Builds the codec string WebCodecs asks for out of the front of the SPS. E.g. avc1.640034 */
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
