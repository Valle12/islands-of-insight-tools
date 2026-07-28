#include "SolverClock.h"

uint64_t deadlineFrom(const uint32_t maxMs) {
  return maxMs == 0 ? 0 : nowMs() + maxMs;
}
