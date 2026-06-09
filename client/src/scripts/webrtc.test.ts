import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshManager } from './webrtc';

const pcs: any[] = [];

class FakePC {
  localDescription: any;
  remoteDescription: any;
  connectionState = 'new';
  ontrack: any = () => {};
  onicecandidate: any = () => {};
  onconnectionstatechange: any = () => {};
  senders: any[] = [];
  constructor(public cfg: any) {
    pcs.push(this);
  }
  addTrack(track: any) {
    this.senders.push({ track, replaceTrack: vi.fn(async () => {}) });
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: any) {
    this.remoteDescription = d;
  }
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
}
(globalThis as any).RTCPeerConnection = FakePC;

function fakeStream() {
  const tracks = [
    { kind: 'audio', enabled: true },
    { kind: 'video', enabled: true },
  ];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as any;
}

describe('MeshManager', () => {
  beforeEach(() => {
    pcs.length = 0;
  });

  it('initiator creates offer, adds tracks, ignores duplicate peer', async () => {
    const send = vi.fn();
    const m = new MeshManager(fakeStream(), send);
    await m.addPeer('p1', true);
    expect(pcs.length).toBe(1);
    expect(pcs[0].senders.length).toBe(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer', to: 'p1', sdp: 'offer-sdp' }));
    await m.addPeer('p1', true); // duplicate → no-op
    expect(pcs.length).toBe(1);
  });

  it('answers offers, relays ice/track events, handles failure', async () => {
    const send = vi.fn();
    const m = new MeshManager(fakeStream(), send);
    const onRemote = vi.fn();
    const onRemoved = vi.fn();
    m.onRemoteStream = onRemote;
    m.onPeerRemoved = onRemoved;

    await m.handleOffer('p2', 'remote-offer');
    const pc = pcs[0];
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'remote-offer' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', to: 'p2', sdp: 'answer-sdp' }));

    pc.onicecandidate({ candidate: { toJSON: () => ({ c: 1 }) } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ice', to: 'p2', candidate: { c: 1 } }));
    pc.onicecandidate({ candidate: null }); // nothing sent

    pc.ontrack({ streams: [{ id: 's' }] });
    expect(onRemote).toHaveBeenCalledWith('p2', { id: 's' });

    await m.handleAnswer('p2', 'ans');
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ans' });

    await m.handleIce('p2', { c: 2 });
    expect(pc.addIceCandidate).toHaveBeenCalled();
    pc.addIceCandidate.mockRejectedValueOnce(new Error('bad'));
    await m.handleIce('p2', { c: 3 }); // swallowed, no throw

    pc.connectionState = 'failed';
    pc.onconnectionstatechange();
    expect(onRemoved).toHaveBeenCalledWith('p2');

    // unknown peers are no-ops
    await m.handleAnswer('ghost', 'x');
    await m.handleIce('ghost', {});
  });

  it('toggles tracks, replaces stream, destroys', async () => {
    const send = vi.fn();
    const stream = fakeStream();
    const m = new MeshManager(stream, send);
    await m.addPeer('p1', false);

    m.setAudioEnabled(false);
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    m.setVideoEnabled(false);
    expect(stream.getVideoTracks()[0].enabled).toBe(false);

    m.setLocalStream(fakeStream());
    expect(pcs[0].senders.some((s: any) => s.replaceTrack.mock.calls.length > 0)).toBe(true);

    m.destroy();
    expect(pcs[0].close).toHaveBeenCalled();

    const onRemoved = vi.fn();
    m.onPeerRemoved = onRemoved;
    m.removePeer('ghost');
    expect(onRemoved).toHaveBeenCalledWith('ghost');
  });
});
