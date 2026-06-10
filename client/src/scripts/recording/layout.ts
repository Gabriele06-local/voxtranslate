// Composite recording (spec 0010) — pure tile geometry. No DOM access so the
// math is unit-testable in node.

export const COMP_W = 1280;
export const COMP_H = 720;
export const GAP = 4;

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COL_W = (COMP_W - GAP) / 2; // 638
const ROW_H = (COMP_H - GAP) / 2; // 358

/**
 * Tile rects for n participants on the 1280×720 canvas, 4px black gaps:
 * 1 = full frame, 2 = side-by-side columns, 3 = two top + one centered
 * bottom, 4 = 2×2 grid. n is clamped to 1..4 (mesh max).
 */
export function computeLayout(n: number): Tile[] {
  switch (Math.max(1, Math.min(4, n))) {
    case 1:
      return [{ x: 0, y: 0, w: COMP_W, h: COMP_H }];
    case 2:
      return [
        { x: 0, y: 0, w: COL_W, h: COMP_H },
        { x: COL_W + GAP, y: 0, w: COL_W, h: COMP_H },
      ];
    case 3:
      return [
        { x: 0, y: 0, w: COL_W, h: ROW_H },
        { x: COL_W + GAP, y: 0, w: COL_W, h: ROW_H },
        { x: (COMP_W - COL_W) / 2, y: ROW_H + GAP, w: COL_W, h: ROW_H },
      ];
    default:
      return [
        { x: 0, y: 0, w: COL_W, h: ROW_H },
        { x: COL_W + GAP, y: 0, w: COL_W, h: ROW_H },
        { x: 0, y: ROW_H + GAP, w: COL_W, h: ROW_H },
        { x: COL_W + GAP, y: ROW_H + GAP, w: COL_W, h: ROW_H },
      ];
  }
}

/**
 * Letterbox a srcW×srcH frame inside `tile` (contain-fit: no distortion, no
 * crop, centered). Degenerate sources fall back to the full tile.
 */
export function containFit(srcW: number, srcH: number, tile: Tile): Tile {
  if (srcW <= 0 || srcH <= 0) return tile;
  const scale = Math.min(tile.w / srcW, tile.h / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: tile.x + (tile.w - w) / 2, y: tile.y + (tile.h - h) / 2, w, h };
}
