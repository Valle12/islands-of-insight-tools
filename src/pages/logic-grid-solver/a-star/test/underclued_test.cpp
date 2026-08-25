#include "TestBoards.h"

#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"

#include <gtest/gtest.h>
#include <vector>

// The forced pass's own seams — what `reference_test.cpp`'s brute-force
// comparison would be too coarse to name when it breaks.
namespace {

using namespace lg;
using rules::Rule;

/**
 * A witnessless run still reports the deduction. When the first search finds
 * no solution inside its budget, nothing is proven — but deduceRoot's
 * propagation already holds: every cell it settled is implied by the givens
 * and rules whatever the search never found. The old path discarded `known`
 * on exactly the boards hard enough to need it, and the page then showed
 * "nothing could be settled" over a board that was a third deduced.
 */
TEST(Underclued, AWitnesslessRunStillReportsTheDeduction) {
  Puzzle puzzle = test::board({"D..", "...", "..."},
                              test::ruleSet({Rule::Underclued}));
  const Model model = buildModel(puzzle);
  // One node of budget: the witness search aborts before it can finish, and
  // aborting is the case under test — an exhausted search answers Unsolvable
  // instead, and a finished one Deduced.
  constexpr Config cfg{.maxMs = 30000, .maxNodes = 1};
  const Outcome outcome = runForced(model, cfg);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_FALSE(outcome.proven);
  EXPECT_GE(outcome.decided, 1);
  EXPECT_EQ(outcome.colors[0], kDark);
  EXPECT_TRUE(outcome.witnesses.empty());
}

} // namespace
