import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioCapture } from './audio-capture';

let lastRecorder: any;

class FakeRecorder {
  static supported = true;
  static shouldThrow = false;
  static isTypeSupported() {
    return FakeRecorder.supported;
  }
  state = 'inactive';
  ondataavailable: any = () => {};
  onstop: any = () => {};
  constructor(
    public stream: any,
    public opts: any,
  ) {
    if (FakeRecorder.shouldThrow) throw new Error('unsupported');
    lastRecorder = this;
  }
  start(_t: number) {
    void _t;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop();
  }
}
(globalThis as any).MediaRecorder = FakeRecorder;
(globalThis as any).WebSocket = { OPEN: 1 };
(globalThis as any).MediaStream = class {
  constructor(public tracks: any[]) {}
};

const fakeWs = (open = true) => ({ readyState: open ? 1 : 0, send: vi.fn() }) as any;
const fakeStream = (audio = true) => ({ getAudioTracks: () => (audio ? [{ kind: 'audio' }] : []) }) as any;

describe('AudioCapture', () => {
  beforeEach(() => {
    FakeRecorder.supported = true;
    FakeRecorder.shouldThrow = false;
    lastRecorder = undefined;
  });

  it('start streams chunks and sends control frames; stop flushes', () => {
    const ws = fakeWs();
    const ac = new AudioCapture(fakeStream(), ws);
    ac.start();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'start' }));
    expect(lastRecorder.state).toBe('recording');

    lastRecorder.ondataavailable({ data: { size: 10 } });
    expect(ws.send).toHaveBeenCalledWith({ size: 10 });

    const calls = ws.send.mock.calls.length;
    lastRecorder.ondataavailable({ data: { size: 0 } }); // empty → not sent
    expect(ws.send.mock.calls.length).toBe(calls);

    ac.start(); // already active → no-op
    ac.stop();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'stop' }));
  });

  it('handles no audio track, unsupported mime, constructor failure, setMuted/setStream', () => {
    const ws = fakeWs();

    const ac0 = new AudioCapture(fakeStream(false), ws);
    ac0.start();
    expect(lastRecorder).toBeUndefined(); // nothing recorded without an audio track

    FakeRecorder.supported = false;
    const ac = new AudioCapture(fakeStream(), ws);
    ac.start();
    expect(lastRecorder.opts.mimeType).toBe('audio/webm'); // fallback mime
    ac.setMuted(true); // stop
    ac.setMuted(false); // start again
    expect(lastRecorder.state).toBe('recording');

    FakeRecorder.shouldThrow = true;
    const ac2 = new AudioCapture(fakeStream(), ws);
    ac2.start(); // constructor throws → swallowed
    ac2.setStream(fakeStream());
  });

  it('does not send control when the socket is closed', () => {
    const ws = fakeWs(false);
    const ac = new AudioCapture(fakeStream(), ws);
    ac.start();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
