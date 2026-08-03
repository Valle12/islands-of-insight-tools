#include "Probe.h"

#include "Bitboard.h"
#include "Budget.h"
#include "Domains.h"
#include "Propagate.h"
#include "Puzzle.h"
#include "Types.h"

#include <cstdint>

namespace lg {
namespace {

/// What one hypothesis left behind.
struct Side {
  bool feasible = false;
  Bits dark;
  Bits light;
};

Side tryColor(const Model &model, Domains &domains, const int cell,
              const uint8_t color) {
  Side side;
  const Domains::Snapshot snapshot = domains.snapshot();
  side.feasible = domains.assign(cell, color) && propagate(model, domains);
  if (side.feasible) {
    side.dark = domains.definite(kDark);
    side.light = domains.definite(kLight);
  }
  domains.restore(snapshot);
  return side;
}

bool commit(const Model &model, Domains &domains, const int cell,
            const uint8_t color) {
  return domains.assign(cell, color) && propagate(model, domains);
}

/**
 * Cells that came out the same colour whichever way the hypothesis went.
 *
 * The case split is exhaustive — the cell is one colour or the other — so a
 * cell both branches agree on holds that colour in every solution. It costs
 * nothing beyond the two propagations already paid for, and it is the same
 * reasoning an underclued answer is made of, one cell deep.
 */
bool takeCommon(const Model &model, Domains &domains, const Side &first,
                const Side &second, bool &changed) {
  const Bits dark = first.dark & second.dark;
  const Bits light = first.light & second.light;
  for (int i = dark.nextSet(0); i >= 0; i = dark.nextSet(i + 1)) {
    if (domains.colorOf(i) == kDark)
      continue;
    changed = true;
    if (!domains.assign(i, kDark))
      return false;
  }
  for (int i = light.nextSet(0); i >= 0; i = light.nextSet(i + 1)) {
    if (domains.colorOf(i) == kLight)
      continue;
    changed = true;
    if (!domains.assign(i, kLight))
      return false;
  }
  return propagate(model, domains);
}

ProbeResult probeCell(const Model &model, Domains &domains, const int cell,
                      bool &changed) {
  using enum ProbeResult;
  const Side dark = tryColor(model, domains, cell, kDark);
  const Side light = tryColor(model, domains, cell, kLight);
  if (!dark.feasible && !light.feasible)
    return Conflict;

  if (dark.feasible != light.feasible) {
    changed = true;
    const uint8_t color = dark.feasible ? kDark : kLight;
    return commit(model, domains, cell, color) ? Fixpoint : Conflict;
  }
  return takeCommon(model, domains, dark, light, changed) ? Fixpoint : Conflict;
}

} // namespace

ProbeResult probeToFixpoint(const Model &model, Domains &domains,
                            Budget &budget) {
  using enum ProbeResult;
  bool changed = true;
  while (changed) {
    changed = false;
    // One probe per CELL. Every square of a merged cell would probe the same
    // two colourings and reach the same conclusion, and a probe is two full
    // propagations — the most expensive thing done per candidate here.
    const Bits candidates = domains.undecided() & model.representatives;
    for (int cell = candidates.nextSet(0); cell >= 0;
         cell = candidates.nextSet(cell + 1)) {
      // Aborted, never Conflict: a look-ahead that ran out of budget has shown
      // NOTHING, and reading it as a refutation is how this kind of solver goes
      // quietly unsound.
      if (budget.exhaustedNow())
        return Aborted;
      // The snapshot was taken before this pass started deciding things.
      if (!domains.undecided().test(cell))
        continue;
      if (probeCell(model, domains, cell, changed) == Conflict)
        return Conflict;
    }
  }
  return Fixpoint;
}

} // namespace lg
