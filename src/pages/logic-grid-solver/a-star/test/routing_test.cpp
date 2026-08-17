#include "TestBoards.h"

#include "Puzzle.h"
#include "Routing.h"
#include "Rules.h"
#include "Search.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <string>
#include <vector>

namespace {

using namespace lg;
using rules::Rule;

constexpr Config kCfg{.maxMs = 30000};

Outcome route(const Puzzle &puzzle) {
  return routing::runRouting(buildModel(puzzle), kCfg);
}

/// Two letter pairs that have to be kept apart on an open board. The router
/// gives each a region of its own and paints the rest the other colour.
TEST(Routing, SeparatesTwoLetterPairs) {
  const Puzzle puzzle = test::board({"a.b", "...", "a.b"});
  const Outcome outcome = route(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  // Every witness this arm returns has already been through the oracle, and
  // saying so here is what makes that a property of the arm rather than of one
  // code path inside it.
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
}

/// The captured 23x21 shape in miniature: a lattice of given dark cells with
/// letter pairs in the gaps between them. Neither the DFS nor the sweep is any
/// use on the full board, and this is the structure that makes it so.
TEST(Routing, SolvesAPillarLattice) {
  Puzzle puzzle = test::board({"a...a", ".....", "b...b", ".....", "....."});
  for (const auto &[x, y] : {std::pair{1, 1}, std::pair{3, 1},
                             std::pair{1, 3}, std::pair{3, 3}})
    test::withGiven(puzzle, x, y, kDark);
  const Outcome outcome = route(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
}

/// A board with no way to keep the letters apart. The router must answer
/// `Unsolved` and NOT `Unsolvable`: it is a construction, and failing to build
/// something proves nothing about whether it exists.
TEST(Routing, NeverClaimsUnsolvable) {
  // Two pairs at opposite corners: their regions would have to CROSS, and on a
  // flat board two regions that cross are one region. No colouring exists, and
  // the router has to say it did not find one rather than that there is none.
  const Puzzle puzzle = test::board({"a.b", "...", "b.a"});
  const Outcome outcome = route(puzzle);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_FALSE(outcome.proven);
}

/// The gate is about not wasting budget, and it declines everything the
/// construction does not model. Each of these would otherwise be routed and
/// then thrown away by the oracle.
TEST(Routing, DeclinesWhatItDoesNotModel) {
  // A rule: "every cell the router did not claim takes the other colour"
  // breaks all but the emptiest rule set.
  EXPECT_FALSE(routing::applicable(buildModel(
      test::board({"a.b", "...", "a.b"}, test::ruleSet({Rule::NoDark2x2})))));

  // A clue that is not a letter.
  Puzzle dart = test::board({"a.b", "...", "a.b"});
  test::withDart(dart, 1, 1, 1, kDirUp);
  EXPECT_FALSE(routing::applicable(buildModel(dart)));

  // A merged cell: the router paints per square.
  Puzzle merged = test::board({"a.b", "...", "a.b"});
  test::withShape(merged, {{0, 1}, {1, 1}});
  EXPECT_FALSE(routing::applicable(buildModel(merged)));

  // One letter has nothing to be kept apart from.
  EXPECT_FALSE(routing::applicable(buildModel(test::board({"a.a"}))));

  // ...and the shape it does take.
  EXPECT_TRUE(routing::applicable(buildModel(test::board({"a.b", "...", "a.b"}))));
}

/// Letters pinned to DIFFERENT colours by their givens are out of scope, and
/// the arm gives up at once rather than spending its budget: the construction
/// paints one colour for every net and the other everywhere else, which cannot
/// express a board whose letters disagree. `logicGridTest67` is the captured
/// case, and the profile sweep is what answers it.
TEST(Routing, GivesUpAtOnceOnLettersOfDifferentColours) {
  Puzzle puzzle = test::board({"a.b", "...", "a.b"});
  test::withGiven(puzzle, 0, 0, kDark);
  test::withGiven(puzzle, 2, 0, kLight);
  const Outcome outcome = route(puzzle);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  // No rounds were run at all — the terminals are checked before any routing.
  EXPECT_EQ(outcome.stats.nodesExpanded, 0);
}

} // namespace
