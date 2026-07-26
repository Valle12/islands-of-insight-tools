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
   running the pthreads cascade (`-pthread -sPTHREAD_POOL_SIZE=10`), which
   races all 8 arms (hier, flat drag, unit, corridor, assembly, relevance+POR,
   jam restarts, guided beam — the last two jam-profile gated) on real
   `std::thread`s inside one shared heap (`ParallelCascade.h`). Arms stop each
   other through the cooperative `Config::cancel` atomic; only the calling
   module thread touches JS (arm progress flows through atomics, forwarded from
   the polling loop). The module is `astar.threads.mem64.mjs` (8GB shared
   64-bit heap) where the engine validates a shared 64-bit memory, else
   `astar.threads.mjs` (4GB) — see layer 4. Because all 8 arms share one heap,
   4GB splits across them and the deep arms hit the wall soonest, so this is
   the path where the bigger heap matters most. Verified end-to-end in Chromium
   against the header-less dev server (which selects the 8GB shared build).
   Browsers without service workers or `credentialless` simply stay on layer 1.

3. **wasm SIMD** — `SM_SIMD=1 bun run build:wasm` adds `-msimd128` (needs no
   isolation). Measured (fixed-node-cap throughput, `benchWasmSimd.ts`,
   medians of 3): drag engine 23144→23008 ms (−0.6%), unit engine
   55005→52967 ms (−3.7%). The engines are bound by hash-map/heap work and
   irregular branching, not vectorizable loops, so auto-vectorization buys
   almost nothing — the flag stays opt-in and the default build ships
   without it.

4. **MEMORY64 build** (`astar.mem64.mjs`, `-sMEMORY64=1 -sMAXIMUM_MEMORY=8GB`)
   — added 2026-07-23. A flat search (drag/unit) holds every expanded node's
   state map + per-expansion scratch resident, ~2.0-2.4KB/node measured, so it
   grows ~linearly and hits the wasm32 **4GB wall at ~1.7M nodes** — on a hard
   board that is an *abort at ~25% of the time budget* (~65s of a 300s arm),
   not a clean "no solution". A 64-bit heap moves the wall to 8GB: the same
   flat arm that aborted at 3.65GB on wasm32 runs to 7.88GB on mem64 (measured
   on fuzz-23444). The bridge prefers this build in the worker-pool portfolio
   wherever the runtime can load it, detected by `WebAssembly.validate` of a
   13-byte 64-bit-memory module, and falls back to `astar.mjs`. **Node loads
   it; bun (1.3.x) cannot yet** ("Memory64 is not enabled"), so the bun
   `wasm.test.ts` suite can never exercise it — a `node --test` gate
   (`test:mem64`, wired into CI) covers correctness instead. Browsers enable
   Memory64 behind a flag today, natively soon. Not a per-board fix: it does
   not by itself crack 23444/29534 (deeper than 8GB of flat search, and the
   jam-class arms that could either decline on 23444's aspect gate or already
   run their full budget). Its value is robustness — the deep arms finish
   their budget instead of aborting. NOT node caps: a cap low enough to bound
   the heap also cuts legitimate near-wall solves (shiftingMosaicTest37 finds
   its plan at ~1.3M nodes / ~3GB on the flat drag arm), and the abort it would
   prevent is already contained per-worker.

   **Two builds, gated separately (2026-07-23):** the isolated (threads) path
   and the fallback (multi-worker) path each get their own 64-bit build, and
   they are DIFFERENT capabilities:
     - `astar.threads.mem64.mjs` — pthreads + a *shared* 8GB 64-bit heap, for
       the layer-2 isolated cascade. Gated on a `WebAssembly.validate` of a
       SHARED 64-bit memory. This is the common production case (the coi shim
       makes the page cross-origin isolated — verified in Chromium), so it is
       the primary path and the one where a bigger heap matters most (8 arms
       share it). `-pthread -sMEMORY64=1` builds cleanly on emcc 5.0.7 and
       Chromium instantiates and solves on it (e2e, network-confirmed the
       worker fetched the threads.mem64 module, no fallback).
     - `astar.mem64.mjs` — single-threaded, *non-shared* 8GB heap, for the
       non-isolated multi-worker fallback (each worker its own heap). Gated on
       a non-shared 64-bit-memory validate.
   Neither loads under bun; browsers enable Memory64 behind a flag today,
   natively soon. Full variant priority: `threads-mem64` > `threads` >
   `mem64` > `default`.

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
