# 0004 — Quality gate: test suites ≥85% coverage + CI (fmt/clippy)

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-09 |
| **Shipped** | 2026-06-09 |
| **Version** | pre-v1.0.0 |
| **Commits** | `f1e724c`, `df238d6`, `eb98664` |
| **Depends on** | [0002](../0002-video-calls-translated-chat/spec.md) |

## 1. Context & Problem

Before adding money and PII to the product, the pipeline needed a **safety net**: a
real test suite on both server and client, an enforced coverage floor, and CI that
blocks regressions in formatting, lints, and behavior. This spec establishes the
quality gate that every later feature ([0005](../0005-accounts-credits-billing/spec.md)–[0008](../0008-managed-content-i18n/spec.md))
must keep green.

## 2. Goals / Non-Goals

**Goals**
- Server (Rust) and client (TS) test suites with **≥85% coverage** on every file.
- CI on every push/PR: build, test, **rustfmt** check, **clippy** (deny warnings).
- A visible CI status badge.
- Deterministic unit coverage for the tricky client modules (`webrtc`, `audio-capture`).

**Non-Goals**
- 100% coverage (diminishing returns); the floor is 85%.
- Load/performance testing.

## 3. Requirements

- **R1 — Coverage floor.** *Given* a change, *when* CI runs coverage, *then* every file is
  ≥85% lines or CI fails (server via `cargo llvm-cov`, client via vitest).
- **R2 — Format gate.** *Given* a push, *when* CI runs `cargo fmt --check`, *then* unformatted code fails.
- **R3 — Lint gate.** *Given* a push, *when* CI runs `clippy`, *then* warnings fail the build.
- **R4 — WebRTC/capture are unit-tested.** *Given* the browser modules, *when* tests run,
  *then* `webrtc.test.ts` and `audio-capture.test.ts` exercise them deterministically (mocked media APIs).
- **R5 — Status visibility.** A CI badge reflects the latest `main` build state.

## 4. Design & Architecture

**Server**
- `cargo llvm-cov` for coverage. **Gotcha (load-bearing):** HTTP/WS/DB integration tests
  live in their own test **binary** (`server/tests/`), not in lib `#[cfg(test)]`, because
  llvm-cov aggregates external integration binaries reliably; env-mutating tests are isolated
  in their own binary too. See [[server-coverage-gotchas]].
- `cargo fmt --check` + `clippy -D warnings` as separate CI steps.

**Client**
- **vitest** unit tests with coverage (`vitest.config.ts`, `mcr.config.cjs`); browser media
  APIs (getUserMedia, RTCPeerConnection, MediaRecorder, SpeechSynthesis) are mocked.
- TypeScript `tsc --noEmit` type-check.

**CI (`.github/workflows/`)**
- Jobs: build+test (server), build+test (client), fmt, clippy. Coverage thresholds enforced.

**Key decisions**
- **Integration tests in a separate binary** → reliable llvm-cov aggregation (the alternative,
  lib `#[cfg(test)]`, under-reports). This shaped the test layout for all later DB features.
- **85% floor, not 100%** → catches real regressions without ossifying the code.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Server + client suites to ≥85% | `server/tests/*`, `client/src/scripts/*.test.ts` |
| S1 | `webrtc`/`audio-capture` unit tests | `client/src/scripts/{webrtc,audio-capture}.test.ts` |
| S2 | CI workflows + coverage gate | `.github/workflows/*` |
| S3 | rustfmt + clippy gates + badge | `.github/workflows/*`, `README.md` |

## 6. Testing & Verification

- This spec *is* the test infrastructure. Verified by green CI on `main` and the badge.
- Later features extended it: billing integration tests in `server/tests/billing.rs` (8 tests),
  `server/tests/config_env.rs` (env-mutating), client e2e in `client/e2e/` (Playwright).

## 7. Deployment & Operations

- CI runs on GitHub Actions; coverage tools: `cargo llvm-cov` (needs `LLVM_COV`/`LLVM_PROFDATA`
  pointed at the toolchain `bin/`), vitest coverage.
- Local Postgres for integration tests: docker `vox-pg` on `127.0.0.1:5433`, db `voxtest`.

## 8. Risks / Open Items

- `cargo llvm-cov` needs `127.0.0.1` (not `localhost`) for the CI Postgres service and the
  toolchain coverage components present — captured in [[server-coverage-gotchas]].

## 9. References

- Commits: `f1e724c`, `df238d6`, `eb98664`
- Files: `.github/workflows/*`, `server/tests/*`, `client/{vitest.config.ts,mcr.config.cjs}`, `client/src/scripts/*.test.ts`
- Memory: [[server-coverage-gotchas]]
