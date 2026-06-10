// Composite recording (spec 0010) — shared types.

/** One participant feeding the composite: self first, then join order. */
export interface ParticipantSource {
  peerId: string;
  name: string;
  /** Live A/V stream (camera or screen share); null = no media yet. */
  stream: MediaStream | null;
  /** True renders the placeholder tile (initials + name) instead of video. */
  videoOff: boolean;
}

export interface CompositeRecorderOptions {
  /** Initial participants (self first, then join order). */
  sources: ParticipantSource[];
  /**
   * Mid-session MediaRecorder failure. Collected chunks are kept — callers
   * should stop() to save the partial file and toast the user.
   */
  onError?: (err: unknown) => void;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}
