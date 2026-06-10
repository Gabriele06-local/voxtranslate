# 0003 — Client experience: PWA, pre-join, call layout, icons

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-09 |
| **Shipped** | 2026-06-09 |
| **Version** | pre-v1.0.0 |
| **Commits** | `30a705c`, `62bda76`, `bf8ebec`, `f9dff1f`, `b46961d`, `3bfe95a`, `0304021`, `93ba7c7`, `cfb7997`, `6906d82` |
| **Depends on** | [0002](../0002-video-calls-translated-chat/spec.md) |

## 1. Context & Problem

The pipeline worked but the product didn't yet *feel* like an app: no install
affordance, no way to check your camera/mic before being seen, a call grid that
cropped or letterboxed video, overlapping subtitle text, and emoji-as-icons. This
spec collects the experience work that made VoxTranslate installable, predictable,
and visually coherent — with **zero runtime dependencies** for icons.

## 2. Goals / Non-Goals

**Goals**
- **Installable PWA**: manifest + service worker + maskable icon; works offline-to-shell.
- **Pre-join screen**: preview camera, mute mic/camera *before* entering a room.
- **Solid call layout**: video fills its cell (`cover`, no bars), grid is viewport-locked and centered, camera-off shows a centered avatar circle.
- **Readable subtitles/chat**: original and translated text never overlap; chat sender is bold inline.
- **Inline SVG icon set** with no icon-font/library dependency.
- **TypeScript type-check tooling** wired in; dev toolbar disabled.

**Non-Goals**
- Full offline use of the call itself (real-time features need the network).
- Theming/design-system tokens (later UI polish; not in this slice).

## 3. Requirements

- **R1 — Install as an app.** *Given* a supported browser, *when* I visit, *then* I can
  install VoxTranslate (manifest + SW + 512×512 maskable icon) and launch it standalone.
- **R2 — Check myself before joining.** *Given* the pre-join screen, *when* I open it,
  *then* I see my camera preview and can toggle mic/camera off **before** entering; the
  chosen state carries into the room.
- **R3 — Camera-off preview.** *Given* my camera is off in pre-join, *when* logged in,
  *then* the preview shows my Google photo (see [0005](../0005-accounts-credits-billing/spec.md)),
  otherwise a centered avatar circle — never a stretched full-bleed image.
- **R4 — Video fills the cell.** *Given* a peer tile, *when* video renders, *then* it uses
  `object-fit: cover` (no letterbox/pillarbox) and the grid stays centered and viewport-locked.
- **R5 — No text overlap.** *Given* interim + final subtitles (or original + translated chat),
  *when* both are present, *then* they stack/replace cleanly without overlapping.
- **R6 — Dependency-free icons.** *Given* any icon in the UI, *when* it renders, *then* it is
  an inline SVG from `icons.ts` (no external icon font/library).

## 4. Design & Architecture

**Files (`client/`)**
- `public/manifest.webmanifest`, service worker, `icon.png` (512×512 maskable) — PWA shell.
- `src/scripts/icons.ts` — stylized inline SVG icon set (zero deps).
- `src/scripts/app.ts` — pre-join screen, call grid CSS, mute toggles, subtitle stacking.
- `astro.config.mjs`, `tsconfig.json` — type-check tooling; Astro dev toolbar disabled.

**Layout rules (CSS in components/`app.ts`)**
- Tiles: `object-fit: cover`; grid: viewport-locked, centered; camera-off: centered circular avatar.
- Subtitles: interim and final occupy a single managed region per speaker (no absolute overlap).

**Key decisions**
- **Inline SVG over an icon library** → no dependency, no FOUC, full control over stroke/scale.
- **Pre-join mute state is authoritative** → what you set in pre-join is what peers see on entry
  (mute is also signaled, see [0002](../0002-video-calls-translated-chat/spec.md) R6).
- **PWA shell only** — the app installs and opens offline to its shell; live features still need the network.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | PWA: manifest + service worker + icon | `client/public/*`, `icon.png` |
| S1 | Pre-join camera preview + mic/camera mute | `client/src/scripts/app.ts` |
| S2 | Call grid layout fixes (cover/centered/avatar) | `client/src/scripts/app.ts`, layout CSS |
| S3 | Subtitle/chat no-overlap + bold inline sender | `client/src/scripts/{app,chat}.ts` |
| S4 | Inline SVG icon set | `client/src/scripts/icons.ts` |
| S5 | TS type-check tooling, disable dev toolbar | `client/tsconfig.json`, `astro.config.mjs` |

## 6. Testing & Verification

- TypeScript type-check gate (`tsc --noEmit`) wired into tooling.
- Manual verification of PWA install + pre-join + layout across the fix commits;
  client unit coverage formalized in [0004](../0004-quality-testing-ci/spec.md).

## 7. Deployment & Operations

- Service worker is registered in production; **note:** the SW intercepts `/api`, which
  later required e2e tests to set `serviceWorkers: 'block'` (see [0005](../0005-accounts-credits-billing/spec.md)).
- Deploys with the Astro client on Vercel.

## 8. Risks / Open Items

- The PWA service worker can shadow `/api` during tests/dev → mitigated by blocking SWs in e2e.
- No design tokens yet → visual consistency maintained by hand.

## 9. References

- Commits: `30a705c`, `62bda76`, `bf8ebec`, `f9dff1f`, `b46961d`, `3bfe95a`, `0304021`, `93ba7c7`, `cfb7997`, `6906d82`
- Files: `client/public/*`, `client/src/scripts/{app,chat,icons}.ts`, `client/{astro.config.mjs,tsconfig.json}`
