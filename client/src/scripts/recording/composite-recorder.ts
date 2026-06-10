// Composite recording (spec 0010) — orchestrates compositor + mixer +
// MediaRecorder. Constructing starts the recording (call from the record
// button click so the AudioContext gets its user gesture). Chunks stay in
// memory for v1 (10 min ≈ 190 MB); FS Access streaming is a follow-up.

import { AudioMixer } from './audio-mixer';
import { CanvasCompositor } from './canvas-compositor';
import { pickMimeType } from './utils';
import type { CompositeRecorderOptions, ParticipantSource } from './types';

export class CompositeRecorder {
  /** ms epoch of start — drives the MM:SS elapsed timer in the UI. */
  readonly startedAt: number;

  private readonly compositor: CanvasCompositor;
  private readonly mixer: AudioMixer;
  private readonly recorder: MediaRecorder;
  private readonly canvasStream: MediaStream;
  private sources: ParticipantSource[] = [];
  private chunks: Blob[] = [];
  private stopPromise: Promise<Blob> | null = null;

  constructor(opts: CompositeRecorderOptions) {
    this.sources = [...opts.sources];
    this.compositor = new CanvasCompositor();
    this.mixer = new AudioMixer();
    this.compositor.start(this.sources);
    for (const s of this.sources) this.mixer.add(s.peerId, s.stream);

    this.canvasStream = this.compositor.captureStream();
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(
      new MediaStream([
        ...this.canvasStream.getVideoTracks(),
        ...this.mixer.stream.getAudioTracks(),
      ]),
      {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: opts.videoBitsPerSecond ?? 2_500_000,
        audioBitsPerSecond: opts.audioBitsPerSecond ?? 128_000,
      },
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // Mid-session failure: keep the chunks collected so far and let the UI
    // decide (stop() → partial file + toast).
    this.recorder.onerror = (e) => opts.onError?.(e);
    this.recorder.start(1000);
    this.startedAt = Date.now();
  }

  /** Add a participant (or refresh one we already track) mid-recording. */
  addParticipant(src: ParticipantSource): void {
    const i = this.sources.findIndex((s) => s.peerId === src.peerId);
    if (i >= 0) this.sources[i] = src;
    else this.sources.push(src);
    this.compositor.setSources(this.sources);
    this.mixer.add(src.peerId, src.stream);
  }

  removeParticipant(peerId: string): void {
    this.sources = this.sources.filter((s) => s.peerId !== peerId);
    this.compositor.setSources(this.sources);
    this.mixer.remove(peerId);
  }

  /** Swap a participant's stream (e.g. self camera ↔ screen share). */
  updateStream(peerId: string, stream: MediaStream | null): void {
    const src = this.sources.find((s) => s.peerId === peerId);
    if (!src) return;
    src.stream = stream;
    this.compositor.updateSource(peerId, stream);
    this.mixer.add(peerId, stream);
  }

  setVideoOff(peerId: string, off: boolean): void {
    const src = this.sources.find((s) => s.peerId === peerId);
    if (src) src.videoOff = off;
    this.compositor.setVideoOff(peerId, off);
  }

  /**
   * Stop and assemble the WebM. Idempotent — repeat calls return the same
   * promise, so hang-up racing the button is safe.
   */
  stop(): Promise<Blob> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<Blob>((resolve) => {
      const finish = () => {
        this.cleanup();
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'video/webm' }));
      };
      if (this.recorder.state === 'inactive') {
        finish();
      } else {
        this.recorder.onstop = finish;
        this.recorder.stop(); // flushes a final dataavailable before onstop
      }
    });
    return this.stopPromise;
  }

  private cleanup(): void {
    this.compositor.stop();
    this.mixer.close();
    for (const track of this.canvasStream.getTracks()) track.stop();
  }
}
