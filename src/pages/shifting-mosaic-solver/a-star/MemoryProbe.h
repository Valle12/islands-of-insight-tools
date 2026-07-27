#pragma once

#include <cstddef>
#include <cstdint>

// Actual measured memory, for bounding a search before it exhausts the heap.
//
// Why measured bytes rather than a node or state count: maxNodes bounds
// EXPANSIONS, which is not what fills the heap, and a state COUNT is a
// board-dependent proxy — NodeKey stores anchors inline only up to
// InlineCapacity (16) blocks and heap-allocates beyond that, so bytes-per-state
// varies with block count (measured 437 and 460 bytes/state on two boards).
//
// This matters most on the cross-origin-isolated browser path, where all 8
// racing arms share ONE heap (8GB with memory64, 4GB on wasm32). A wasm
// allocation failure ABORTS the module, so one greedy arm can take down arms
// that were about to win. Bounding by measurement lets an arm stop gracefully.
namespace memprobe {

// Bytes currently allocated and not yet freed. 0 means "cannot measure here" —
// callers must treat 0 as "no limit information" and not as "no memory used".
inline uint64_t liveAllocatedBytes();

// The hard ceiling this process/module can ever reach, or 0 if unbounded or
// unknown. Under emscripten this is MAXIMUM_MEMORY, so the same code adapts to
// the 8GB memory64 build and the 4GB wasm32 fallback with no configuration.
inline uint64_t heapCeilingBytes();

// True when the module is about to be killed by heap exhaustion. Always false
// off wasm. Check this even when no budget is configured — an abort destroys
// the whole solve, not just the arm that overran.
inline bool nearHeapLimit();

} // namespace memprobe

#if defined(__EMSCRIPTEN__)

#include <emscripten/heap.h>
// mallinfo is declared by emscripten's compat/malloc.h, which the toolchain
// already places on the include path (-iwithsysroot/include/compat). Include it
// as plain <malloc.h>: reaching it by its explicit compat/ path breaks the
// `#include_next <malloc.h>` at the end of that header ("malloc.h not found").
// dlmalloc — the default allocator, since buildWasm.ts sets no -sMALLOC= — is
// what implements it. Define SM_NO_MALLINFO to fall back if that ever changes.
#ifndef SM_NO_MALLINFO
#include <malloc.h>
#define SM_HAVE_MALLINFO 1
#endif

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
#ifdef SM_HAVE_MALLINFO
  // uordblks = "total allocated space", i.e. LIVE bytes. Deliberately not
  // emscripten_get_heap_size(), which returns the WebAssembly memory size —
  // that is RESERVED and never shrinks, so once a greedy arm has grown it,
  // every later arm would read the peak and stop against a nearly-empty heap.
  return static_cast<uint64_t>(mallinfo().uordblks);
#else
  // Fallback: reserved size. Still predicts an imminent wall (wasm memory
  // cannot grow past its maximum), but it over-reports after a large free.
  return static_cast<uint64_t>(emscripten_get_heap_size());
#endif
}

inline uint64_t heapCeilingBytes() {
  return static_cast<uint64_t>(emscripten_get_heap_max());
}

// Last-resort tripwire, independent of any configured budget.
//
// Under wasm a heap that cannot grow does not fail an allocation — it ABORTS
// the module, so the user loses the entire solve with "RuntimeError:
// Aborted()" instead of getting "no solution". Every configured bound can miss
// this: maxHeapBytes may be 0 (unlimited), and liveAllocatedBytes() returns 0
// on a runtime whose mallinfo is unavailable, which the callers must treat as
// "no information" rather than "no memory used".
//
// emscripten_get_heap_size() is the RESERVED WebAssembly memory. It never
// shrinks, which makes it useless as a per-arm budget, but that is exactly
// what makes it the right abort predictor: reaching the maximum is precisely
// the condition that kills the module.
inline bool nearHeapLimit() {
  const uint64_t maxBytes = static_cast<uint64_t>(emscripten_get_heap_max());
  if (maxBytes == 0)
    return false;
  const uint64_t reserved = static_cast<uint64_t>(emscripten_get_heap_size());
  return reserved >= (maxBytes / 100) * 96;
}

} // namespace memprobe

#elif defined(_WIN32)

// NOMINMAX before windows.h: it otherwise defines min/max as macros, which
// breaks every std::min / std::numeric_limits<T>::max() in the translation
// unit that includes this header. WIN32_LEAN_AND_MEAN keeps the rest out.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
// psapi.h must follow windows.h.
#include <psapi.h>
#if defined(_MSC_VER)
#pragma comment(lib, "Psapi.lib")
#endif

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
  // PrivateUsage (commit charge) rather than WorkingSetSize: the working set
  // collapses under memory pressure while the process still owns the pages, so
  // it under-reports exactly when the number matters. This is also the counter
  // the profiling in HARD-BOARDS.md used, so figures stay comparable.
  PROCESS_MEMORY_COUNTERS_EX pmc{};
  pmc.cb = sizeof(pmc);
  if (!GetProcessMemoryInfo(GetCurrentProcess(),
                            reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&pmc),
                            sizeof(pmc)))
    return 0;
  return static_cast<uint64_t>(pmc.PrivateUsage);
}

inline uint64_t heapCeilingBytes() { return 0; } // no fixed ceiling natively
inline bool nearHeapLimit() { return false; }      // nothing aborts natively

} // namespace memprobe

#elif defined(__linux__)

#include <cstdio>
#include <unistd.h>

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
  // statm field 2 is resident pages. Native RSS and emscripten's uordblks are
  // different quantities — both are real measurements, but do not compare them
  // byte for byte across platforms.
  std::FILE *f = std::fopen("/proc/self/statm", "r");
  if (!f)
    return 0;
  unsigned long total = 0, resident = 0;
  const int got = std::fscanf(f, "%lu %lu", &total, &resident);
  std::fclose(f);
  if (got != 2)
    return 0;
  return static_cast<uint64_t>(resident) *
         static_cast<uint64_t>(sysconf(_SC_PAGESIZE));
}

inline uint64_t heapCeilingBytes() { return 0; }
inline bool nearHeapLimit() { return false; }

} // namespace memprobe

#else

namespace memprobe {
inline uint64_t liveAllocatedBytes() { return 0; } // unsupported platform
inline uint64_t heapCeilingBytes() { return 0; }
inline bool nearHeapLimit() { return false; }
} // namespace memprobe

#endif
