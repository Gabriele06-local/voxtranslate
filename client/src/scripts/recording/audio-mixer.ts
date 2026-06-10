// Composite recording (spec 0010) — mixes every participant's audio at unity
// gain into one MediaStream. The local entry must be the raw mic stream only:
// SpeechSynthesis (TTS) output is not capturable, and peers' original voices
// are mixed even when the ttsOn UI mutes them locally (documented in the spec).

export class AudioMixer {
  private readonly ctx: AudioContext;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly nodes = new Map<
    string,
    { src: MediaStreamAudioSourceNode; gain: GainNode }
  >();

  /** Construct on record start — the button click is the user gesture. */
  constructor() {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
  }

  get stream(): MediaStream {
    return this.dest.stream;
  }

  /** (Re)wire a participant. Streams without audio tracks are skipped. */
  add(peerId: string, stream: MediaStream | null): void {
    this.remove(peerId);
    if (!stream || stream.getAudioTracks().length === 0) return;
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(this.dest);
    this.nodes.set(peerId, { src, gain });
  }

  remove(peerId: string): void {
    const node = this.nodes.get(peerId);
    if (!node) return;
    node.src.disconnect();
    node.gain.disconnect();
    this.nodes.delete(peerId);
  }

  close(): void {
    for (const peerId of [...this.nodes.keys()]) this.remove(peerId);
    void this.ctx.close().catch(() => {});
  }
}
