// A client that speaks to the scrcpy server directly.
//
// Rather than going through the scrcpy executable, this pushes scrcpy-server.jar to the
// device and takes the H.264 stream straight off an adb reverse tunnel. That is what makes
// a virtual display usable: Android's screencap and screenrecord can only capture physical
// displays, so for a virtual display there is no other way to get at the picture.
//
// The server connects twice through the tunnel, video first and control second.
//
// Video stream (scrcpy 4.x, measured against 4.1):
//   device name  64 bytes, NUL-padded
//   codec id     4 bytes, "h264"
//   then 12-byte headers, repeated. The top bit of the first one tells the two kinds apart:
//     session    flags 4 + width 4 + height 4, and no payload. One comes before the first
//                frame and another whenever the capture restarts: a rotation, which is what a
//                game asking for landscape does to a virtual display.
//     media      PTS/flags 8 + length 4, then that many bytes of Annex-B data.
//                bit62 of the PTS word = config packet (SPS/PPS), bit61 = key frame
//
// Control stream: the messages built by the *Message functions below, big-endian, as
// scrcpy's own client writes them. Input injected this way is handled inside the server,
// so a tap costs a socket write instead of an adb process.

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');

const DEVICE_NAME_LEN = 64;
const CODEC_ID_LEN = 4;
const HEADER_LEN = 12; // a session packet and a media packet header alike
const FLAG_SESSION = 0x80000000; // as seen in the high 32 bits of the first word
const FLAG_CONFIG = 0x40000000;
const FLAG_KEY = 0x20000000;
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const SERVER_CLASS = 'com.genymobile.scrcpy.Server';
const MAX_PACKET = 16 * 1024 * 1024;

// The 'closed' event carries a reason code ('server-exited', 'stream-ended',
// 'stream-corrupt', 'stream-disabled') or, for socket errors, the raw message. The caller
// turns the codes into localized text, so this file stays free of vscode and of UI strings.
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
    this.socket = null; // video
    this.controlSocket = null;
    this.proc = null; // the adb shell process
    this.buf = Buffer.alloc(0);
    this.logTail = '';
    this.phase = 'meta';
    this.displayId = null;
    this.session = null; // { width, height } of the current capture
    this.stopped = false;
  }

  /** start() is a chain of awaits, and stop() can land in any of them. */
  checkStopped() {
    if (this.stopped) throw new Error('stopped');
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
    this.checkStopped();
    await this.exec(['push', this.o.serverPath, REMOTE_JAR]);
    this.checkStopped();

    // Let the OS pick the port, then aim the reverse tunnel at it.
    this.server = net.createServer((sock) => this.onSocket(sock));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.checkStopped();
    const port = this.server.address().port;
    await this.exec(['reverse', `localabstract:scrcpy_${this.scid}`, `tcp:${port}`]);
    // A stop() that came while the tunnel was being made had no tunnel to remove yet.
    if (this.stopped) {
      await this.exec(['reverse', '--remove', `localabstract:scrcpy_${this.scid}`]).catch(() => {});
      this.checkStopped();
    }

    const args = [
      '-s', this.o.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process', '/', SERVER_CLASS, this.o.version,
      `scid=${this.scid}`,
      'log_level=info',
      'audio=false', // used at work, so audio never leaves the device
      // With control on, the server pushes the phone's clipboard to us whenever it changes.
      // Nothing here reads it, and like audio it has no business leaving the device.
      'clipboard_autosync=false',
      // With control on, the server would also press POWER on a dark screen. Waking is the
      // caller's job, done with a key that cannot turn the screen off, and only if asked to.
      'power_on=false',
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
    // Output arrives in arbitrary chunks. A line cut in two would hide the display id, and
    // then every tap would be aimed at the wrong display.
    const lines = (this.logTail + text).split(/\r?\n/);
    this.logTail = lines.pop();
    for (const line of lines) {
      const m = /New display: .*?\(id=(\d+)\)/.exec(line);
      if (m) {
        this.displayId = Number(m[1]);
        this.emit('display', this.displayId);
      }
      if (/ERROR/i.test(line)) this.emit('log', line.trim());
    }
  }

  onSocket(sock) {
    // The server connects once per channel, in a fixed order: video, then control.
    if (!this.socket) return this.attachVideo(sock);
    if (!this.controlSocket) return this.attachControl(sock);
    sock.destroy();
  }

  attachVideo(sock) {
    this.socket = sock;
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.emit('closed', e.message));
    sock.on('close', () => {
      if (!this.stopped) this.emit('closed', 'stream-ended');
    });
  }

  attachControl(sock) {
    this.controlSocket = sock;
    // Input is a stream of small writes, and Nagle would hold each one back for an ACK.
    sock.setNoDelay(true);
    // The server only writes here for clipboard and uhid traffic, which is switched off or
    // never asked for. Reading anyway keeps a surprise from backing up the socket.
    sock.on('data', () => {});
    sock.on('error', (e) => this.emit('closed', e.message));
    sock.on('close', () => {
      if (!this.stopped) this.emit('closed', 'stream-ended');
    });
  }

  /**
   * Sends one control message. False when there is nothing to send it on, and for a touch or
   * a scroll before the first session: until then the server has no mapping for positions and
   * would inject them as raw display pixels, somewhere else entirely.
   */
  control(msg) {
    const sock = this.controlSocket;
    if (!sock || sock.destroyed || this.stopped) return false;
    if (!this.session && (msg[0] === MSG_INJECT_TOUCH_EVENT || msg[0] === MSG_INJECT_SCROLL_EVENT)) {
      return false;
    }
    sock.write(msg);
    return true;
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.phase === 'meta') {
        const need = DEVICE_NAME_LEN + CODEC_ID_LEN;
        if (this.buf.length < need) return;
        const name = this.buf.subarray(0, DEVICE_NAME_LEN).toString('utf8').replace(/\0.*$/, '');
        const codecId = this.buf.readUInt32BE(DEVICE_NAME_LEN);
        const codec = this.buf.subarray(DEVICE_NAME_LEN, need).toString('latin1');
        this.buf = this.buf.subarray(need);
        // 0 and 1 are not codecs: the stream is switched off, or the encoder could not be set up.
        if (codecId === 0 || codecId === 1) {
          this.emit('closed', 'stream-disabled');
          return this.stop();
        }
        this.phase = 'frame';
        this.emit('meta', { name, codec });
        continue;
      }
      if (this.buf.length < HEADER_LEN) return;
      const hi = this.buf.readUInt32BE(0);
      // A session packet is a bare header. Its last word is the height, and reading that as a
      // payload length is what used to derail the whole stream on the first rotation.
      if (hi & FLAG_SESSION) {
        const width = this.buf.readUInt32BE(4);
        const height = this.buf.readUInt32BE(8);
        this.buf = this.buf.subarray(HEADER_LEN);
        this.session = { width, height };
        this.emit('session', { width, height });
        continue;
      }
      const len = this.buf.readUInt32BE(8);
      if (len === 0 || len > MAX_PACKET) {
        this.emit('closed', 'stream-corrupt');
        return this.stop();
      }
      if (this.buf.length < HEADER_LEN + len) return;
      const data = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buf = this.buf.subarray(HEADER_LEN + len);
      const type = hi & FLAG_CONFIG ? 'config' : hi & FLAG_KEY ? 'key' : 'delta';
      this.emit('packet', { type, data });
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.socket) this.socket.destroy(); } catch (_) {}
    try { if (this.controlSocket) this.controlSocket.destroy(); } catch (_) {}
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

// ---------- control messages (scrcpy 4.1 app/src/control_msg.c) ----------

const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TOUCH_EVENT = 2;
const MSG_INJECT_SCROLL_EVENT = 3;
const MSG_RESET_VIDEO = 17;

/**
 * MotionEvent actions; KeyEvent's down and up share the first two. A cancel ends a touch
 * without it counting as a click, for a finger still down when the display rotates.
 */
const ACTION = { down: 0, up: 1, move: 2, cancel: 3 };

// Any pointer id but the mouse's (-1) is injected as a finger on a touchscreen, which is the
// only kind of input many games read. The mouse id turns into a mouse as soon as a button
// other than the primary one is involved.
const POINTER_FINGER = -2n;

/**
 * A position is in pixels of the video frame, sent with the size of that frame. The server
 * maps it onto the display itself -- scaling, rotation and all -- and drops an event whose
 * size is not the current one, which is what makes a rotation safe.
 */
function writePosition(b, at, p) {
  b.writeInt32BE(Math.round(p.x), at);
  b.writeInt32BE(Math.round(p.y), at + 4);
  b.writeUInt16BE(p.w, at + 8);
  b.writeUInt16BE(p.h, at + 10);
}

/** A touch. `action` is one of ACTION; a finger that has left the screen carries no pressure. */
function touchMessage(action, p, o = {}) {
  const pointerId = o.pointerId === undefined ? POINTER_FINGER : BigInt(o.pointerId);
  const lifted = action === ACTION.up || action === ACTION.cancel;
  const pressure = o.pressure === undefined ? (lifted ? 0 : 1) : o.pressure;
  const b = Buffer.alloc(32);
  b[0] = MSG_INJECT_TOUCH_EVENT;
  b[1] = action;
  b.writeBigUInt64BE(BigInt.asUintN(64, pointerId), 2);
  writePosition(b, 10, p);
  // u16 fixed point. 1.0 does not fit and is written as 0xffff, as scrcpy's own client does.
  b.writeUInt16BE(Math.min(0xffff, Math.trunc(pressure * 0x10000)), 22);
  b.writeUInt32BE(o.actionButton || 0, 24);
  b.writeUInt32BE(o.buttons || 0, 28);
  return b;
}

/**
 * A mouse wheel. Amounts are in wheel notches, positive up and right as on Android, and
 * scrcpy carries them as 16ths in i16 fixed point, so anything past 16 is clamped.
 */
function scrollMessage(p, hscroll, vscroll, buttons = 0) {
  const fixed = (v) => {
    const n = Math.max(-1, Math.min(1, v / 16));
    return n >= 1 ? 0x7fff : Math.trunc(n * 0x8000);
  };
  const b = Buffer.alloc(21);
  b[0] = MSG_INJECT_SCROLL_EVENT;
  writePosition(b, 1, p);
  b.writeInt16BE(fixed(hscroll), 13);
  b.writeInt16BE(fixed(vscroll), 15);
  b.writeUInt32BE(buttons, 17);
  return b;
}

/** A key. `action` is ACTION.down or ACTION.up; a press is one of each. */
function keyMessage(action, keycode, repeat = 0, metaState = 0) {
  const b = Buffer.alloc(14);
  b[0] = MSG_INJECT_KEYCODE;
  b[1] = action;
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(metaState, 10);
  return b;
}

/** Asks for a fresh session: a session packet, then config and a key frame, right away. */
function resetVideoMessage() {
  return Buffer.from([MSG_RESET_VIDEO]);
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

module.exports = {
  ScrcpyStream,
  codecStringFromConfig,
  ACTION,
  touchMessage,
  scrollMessage,
  keyMessage,
  resetVideoMessage,
};
