// Live microphone input level meter (WebAudio AnalyserNode). Drives the mic
// button "voice halo" so users can see their input is actually picking up
// sound. A muted track (enabled = false) outputs silence, so the level falls
// to 0 on mute without any extra wiring.

/** RMS of unsigned 8-bit time-domain samples, normalized to 0..1. */
export function rmsLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const v = (s - 128) / 128; // center on 0, full scale = ±1
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

export class MicMeter {
  private readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Uint8Array<ArrayBuffer>;
  private raf = 0;
  private smoothed = 0;

  constructor(
    stream: MediaStream,
    private readonly onLevel: (level: number) => void,
  ) {
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.source.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);

    const tick = (): void => {
      this.analyser.getByteTimeDomainData(this.buf);
      // Normal speech RMS is ~0.05–0.3; boost so it reads on the button.
      const raw = Math.min(1, rmsLevel(this.buf) * 4);
      // Fast attack, slow release — tracks speech without flickering.
      this.smoothed = raw > this.smoothed ? raw : this.smoothed * 0.85;
      this.onLevel(this.smoothed < 0.02 ? 0 : this.smoothed);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.source.disconnect();
    void this.ctx.close();
    this.onLevel(0);
  }
}
