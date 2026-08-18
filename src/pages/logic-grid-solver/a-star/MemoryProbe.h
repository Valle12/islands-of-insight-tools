#pragma once

#include <cstdint>

// Platform headers up here rather than beside the implementation that uses
// them: an #include after a declaration is cpp:S954, and these carry the same
// guards the definitions below do, so nothing changes about which ones a given
// build sees. NOMINMAX still precedes <Windows.h> and <Psapi.h> still follows
// it, which are the two orderings that actually matter.
#if defined(__EMSCRIPTEN__)

#include <emscripten/heap.h>
// mallinfo is declared by emscripten's compat/malloc.h, which the toolchain
// already places on the include path (-iwithsysroot/include/compat). Include it
// as plain <malloc.h>: reaching it by its explicit compat/ path breaks the
// `#include_next <malloc.h>` at the end of that header ("malloc.h not found").
// dlmalloc — the default allocator, since buildWasm.ts sets no -sMALLOC= — is
// what implements it. Define LG_NO_MALLINFO to fall back if that ever changes.
#ifndef LG_NO_MALLINFO
#include <malloc.h>
#define LG_HAVE_MALLINFO 1
#endif
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
// Capitalised to match the Windows SDK's own file names — clangd resolves the
// include against the real directory entry and reports a non-portable path for
// the all-lowercase spelling. (Lowercase is the mingw-w64 convention, which
// this project does not target: MSVC, Linux/GCC and emscripten only.)
#include <Windows.h>
// Psapi.h must follow Windows.h.
#include <Psapi.h>
#if defined(_MSC_VER)
#pragma comment(lib, "Psapi.lib")
#endif
#elif defined(__linux__)

#include <cstdio>
#include <unistd.h>
#endif

// Actual measured memory, for bounding a search before it exhausts the heap.
// Same design as the shifting-mosaic solver's probe.
//
// Why measured bytes rather than a node or state count: maxNodes bounds
// EXPANSIONS, which is not what fills the heap, and a state COUNT is a
// board-dependent proxy — NodeKey stores the state inline only up to
// InlineCapacity bytes and heap-allocates beyond that, so bytes-per-state
// varies with block and must-touch counts.
//
// This matters most in the browser, where a wasm allocation failure ABORTS the
// module — the user loses the whole solve as "RuntimeError: Aborted()" instead
// of getting "no solution". Bounding by measurement lets the search stop
// gracefully, and once arms race inside one module they all share ONE heap, so
// a greedy arm can otherwise take down arms that were about to win.
namespace memprobe {

// Bytes currently allocated and not yet freed. 0 means "cannot measure here" —
// callers must treat 0 as "no limit information" and not as "no memory used".
inline uint64_t liveAllocatedBytes();

// The hard ceiling this process/module can ever reach, or 0 if unbounded or
// unknown. Under emscripten this is MAXIMUM_MEMORY, so the same code adapts to
// an 8GB memory64 build and the 4GB wasm32 fallback with no configuration.
inline uint64_t heapCeilingBytes();

// True when the module is about to be killed by heap exhaustion. Always false
// off wasm. Check this even when no budget is configured — an abort destroys
// the whole solve, not just the search that overran.
inline bool nearHeapLimit();

} // namespace memprobe

#if defined(__EMSCRIPTEN__)

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
#ifdef LG_HAVE_MALLINFO
  // uordblks = "total allocated space", i.e. LIVE bytes. Deliberately not
  // emscripten_get_heap_size(), which returns the WebAssembly memory size —
  // that is RESERVED and never shrinks, so once a greedy search has grown it,
  // every later one would read the peak and stop against a nearly-empty heap.
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
// the module. Every configured bound can miss this: maxHeapBytes may be 0
// (unlimited), and liveAllocatedBytes() returns 0 on a runtime whose mallinfo
// is unavailable, which the callers must treat as "no information" rather than
// "no memory used".
//
// emscripten_get_heap_size() is the RESERVED WebAssembly memory. It never
// shrinks, which makes it useless as a per-search budget, but that is exactly
// what makes it the right abort predictor: reaching the maximum is precisely
// the condition that kills the module.
inline bool nearHeapLimit() {
  const auto maxBytes = static_cast<uint64_t>(emscripten_get_heap_max());
  if (maxBytes == 0)
    return false;
  const auto reserved = static_cast<uint64_t>(emscripten_get_heap_size());
  return reserved >= (maxBytes / 100) * 96;
}

} // namespace memprobe

#elif defined(_WIN32)

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
  // PrivateUsage (commit charge) rather than WorkingSetSize: the working set
  // collapses under memory pressure while the process still owns the pages, so
  // it under-reports exactly when the number matters.
  PROCESS_MEMORY_COUNTERS_EX pmc{};
  pmc.cb = sizeof(pmc);
  //
  // GetProcessMemoryInfo is declared to take the BASE struct and documented to
  // accept the _EX one through it — that indirection is the API's, not ours.
  // Spelled as static_cast-through-void* rather than reinterpret_cast because
  // that is the constrained form of the very same conversion (the standard
  // defines one in terms of the other for standard-layout types), and it is
  // what cpp:S3630 asks for. It is a spelling, not extra safety.
  //
  // A union of the two structs was considered and REJECTED: PrivateUsage sits
  // outside the common initial sequence, so reading it back through the _EX
  // member after the API wrote through the base one is undefined behavior.
  if (auto *const asBase =
          static_cast<PROCESS_MEMORY_COUNTERS *>(static_cast<void *>(&pmc));
      !GetProcessMemoryInfo(GetCurrentProcess(), asBase, sizeof(pmc)))
    return 0;
  return pmc.PrivateUsage;
}

inline uint64_t heapCeilingBytes() { return 0; } // no fixed ceiling natively
inline bool nearHeapLimit() { return false; }    // nothing aborts natively

} // namespace memprobe

#elif defined(__linux__)

namespace memprobe {

inline uint64_t liveAllocatedBytes() {
  // statm field 2 is resident pages. Native RSS and emscripten's uordblks are
  // different quantities — both are real measurements, but do not compare them
  // byte for byte across platforms.
  std::FILE *f = std::fopen("/proc/self/statm", "r");
  if (!f)
    return 0;
  unsigned long total = 0;
  unsigned long resident = 0;
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
