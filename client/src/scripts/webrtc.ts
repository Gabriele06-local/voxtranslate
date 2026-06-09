// WebRTC full-mesh manager: one RTCPeerConnection per remote peer. Existing
// peers initiate offers toward a newcomer (avoids offer glare).

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

type Signal =
  | { type: 'offer'; to: string; sdp: string }
  | { type: 'answer'; to: string; sdp: string }
  | { type: 'ice'; to: string; candidate: RTCIceCandidateInit };

export class MeshManager {
  private peers = new Map<string, RTCPeerConnection>();
  private localStream: MediaStream;
  private send: (s: Signal) => void;

  onRemoteStream: (peerId: string, stream: MediaStream) => void = () => {};
  onPeerRemoved: (peerId: string) => void = () => {};

  constructor(localStream: MediaStream, send: (s: Signal) => void) {
    this.localStream = localStream;
    this.send = send;
  }

  /** Replace the local stream's tracks on all peers (e.g. after a device change). */
  setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
    for (const pc of this.peers.values()) {
      const senders = pc.getSenders();
      for (const track of stream.getTracks()) {
        const sender = senders.find((s) => s.track && s.track.kind === track.kind);
        if (sender) void sender.replaceTrack(track);
      }
    }
  }

  async addPeer(peerId: string, isInitiator: boolean): Promise<void> {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(peerId, pc);

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    pc.ontrack = (e) => this.onRemoteStream(peerId, e.streams[0]);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'ice', to: peerId, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId);
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ type: 'offer', to: peerId, sdp: offer.sdp! });
    }
  }

  async handleOffer(fromId: string, sdp: string): Promise<void> {
    if (!this.peers.has(fromId)) await this.addPeer(fromId, false);
    const pc = this.peers.get(fromId);
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ type: 'answer', to: fromId, sdp: answer.sdp! });
  }

  async handleAnswer(fromId: string, sdp: string): Promise<void> {
    const pc = this.peers.get(fromId);
    if (pc) await pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async handleIce(fromId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.peers.get(fromId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore late/duplicate candidates */
    }
  }

  removePeer(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
    this.onPeerRemoved(peerId);
  }

  setAudioEnabled(enabled: boolean): void {
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  setVideoEnabled(enabled: boolean): void {
    this.localStream.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  destroy(): void {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
  }
}
