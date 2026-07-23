# Shifting-mosaic solver: parallelization notes

How the solver uses multiple cores in the browser, and what was measured and
rejected. Written 2026-07 during the drag-space engine work (IIT-21).

## Layers (all shipped)

1. **Worker-pool portfolio** (`wasmBridge.ts`) — default everywhere.
   Plain Web Workers (up to hardwareConcurrency−1, capped by the arm list)
   race independent single-threaded wasm instances with diverse configs:
   assembly, corridor, deep flat drag w=4/settled/PEA64 (cracked
   shiftingMosaicTest37), the jam-restart arm (dig-cost-guided diversified
   rounds — cracked fuzz jams 10276/4722/9164; jam-profile gated), the
   legacy unit-move arm, the receding-horizon `hier` arm, the
   relevance+POR arm, a low-weight quality arm, and the guided-beam jam
   arm. First non-empty plan wins, the rest are terminated. Needs no
   special headers, works on GitHub Pages as-is, and a wasm OOM kills only
   its own arm.

2. **wasm pthreads via cross-origin isolation** — progressive enhancement.
   GitHub Pages cannot set COOP/COEP headers, so `coi-serviceworker.js`
   (site root; registered by the shifting-mosaic page via
   `common/coiRegister.ts`) re-serves responses with
   `Cross-Origin-Embedder-Policy: credentialless` +
   `Cross-Origin-Opener-Policy: same-origin`. `credentialless` keeps the
   third-party gtag.js loading without CORP changes. When
   `crossOriginIsolated` is true, the bridge switches to a single worker
   running `astar.threads.mjs` (`-pthread -sPTHREAD_POOL_SIZE=10`), whose
   cascade races all 8 arms (hier, flat drag, unit, corridor, assembly,
   relevance+POR, jam restarts, guided beam — the last two jam-profile
   gated) on real `std::thread`s inside one shared
   4GB heap (`ParallelCascade.h`). Arms stop each other through the
   cooperative `Config::cancel` atomic; only the calling module thread
   touches JS (arm progress flows through atomics, forwarded from the
   polling loop). Verified end-to-end in Chromium against the header-less
   dev server. Browsers without service workers or `credentialless` simply
   stay on layer 1.

3. **wasm SIMD** — `SM_SIMD=1 bun run build:wasm` adds `-msimd128` (needs no
   isolation). Measured (fixed-node-cap throughput, `benchWasmSimd.ts`,
   medians of 3): drag engine 23144→23008 ms (−0.6%), unit engine
   55005→52967 ms (−3.7%). The engines are bound by hash-map/heap work and
   irregular branching, not vectorizable loops, so auto-vectorization buys
   almost nothing — the flag stays opt-in and the default build ships
   without it.

## WebGPU / WebGL: rejected (measured basis)

A drag expansion is one flood fill over ≤ 1275 anchor cells, each step a
handful of `uint64` shift/AND ops — single-digit microseconds on the CPU.
A per-expansion GPU dispatch costs more than the whole expansion, and the
search's bottlenecks are the hash-map state store and the priority queue,
which do not map to GPU compute. Batched formulations (scoring PEA*
candidates across the frontier, GPU BFS layers) would first require
restructuring the search around large synchronous batches — exactly the
barrier the portfolio avoids — for a stage that is not the measured cost.
WebGL compute (fragment-shader hacks) is strictly worse than WebGPU and was
not considered further. Revisit only if a future engine needs brute-force
breadth (e.g. GPU retrograde packing enumeration for endgame databases).

## Cancellation

`AStar::Config::cancel` / `DragSolver::Config::cancel` point to an
`std::atomic<bool>` checked at the budget checkpoints of every search loop
(A*, drag, hier, assembly, jam restarts, beam). The UI still hard-terminates
workers; the flag exists for in-process arm racing and for any future
cooperative UI cancel.
