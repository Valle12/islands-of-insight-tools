#include "TestBoards.h"

#include "Packing.h"
#include "Puzzle.h"
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

Outcome pack(const Puzzle &puzzle) {
  return packing::runPacking(buildModel(puzzle), kCfg);
}

/// Paints every clue cell of a picture-built board, which is what the packer's
/// gate asks for: the clue colours are the puzzle's to say, not the search's.
void paintClues(Puzzle &puzzle, const uint8_t color) {
  for (const Clue &clue : puzzle.clues)
    puzzle.givens[slot(clue.index)] = color;
}

/// Two area clues that cannot both be satisfied without keeping their regions
/// apart. The packer lays them out and paints everything else dark.
TEST(Packing, PacksTwoAreasOnOneColour) {
  Puzzle puzzle = test::board({"2..2", "....", "...."});
  paintClues(puzzle, kLight);
  const Outcome outcome = pack(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  // Every witness this arm returns has already been through the oracle, and
  // saying so here is what makes that a property of the arm rather than of one
  // code path inside it.
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
}

/// The captured 11x11's shape in miniature: a clue far bigger than anything
/// worth enumerating, which the lookahead grows rather than listing.
TEST(Packing, PacksAClueTooBigToEnumerate) {
  Puzzle puzzle = test::board({".....", ".....", ".....", ".....", "....."});
  test::withClue(puzzle, 0, 0, 12);
  test::withClue(puzzle, 4, 4, 3);
  paintClues(puzzle, kLight);
  const Outcome outcome = pack(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
}

/// Two clues of ONE value close enough to share a region. The captured 11x11
/// has no packing at all unless its two 3-clues do exactly this, so the arm has
/// to allow it rather than insist on a region per clue.
TEST(Packing, LetsTwoEqualCluesShareARegion) {
  // A 3-cell region holding both 3s is the only way to fit them here: apart
  // they would touch, and touching regions are one region of four cells.
  Puzzle puzzle = test::board({".3.", "3..", "..."});
  paintClues(puzzle, kLight);
  const Outcome outcome = pack(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
  const Model model = buildModel(puzzle);
  Bits light;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    if (outcome.colors[slot(i)] == kLight)
      light.set(i);
  // ONE region of three cells holding both clues, not two regions of three.
  EXPECT_EQ(light.count(), 3);
  EXPECT_EQ(component(cellIndex(1, 0), light).count(), 3);
}

/// A board with no packing at all. The arm must answer `Unsolved` and NOT
/// `Unsolvable`: it is a construction, and failing to build something proves
/// nothing about whether it exists.
TEST(Packing, NeverClaimsUnsolvable) {
  // A 4 and a 5 on a 3x3. Different values, so they cannot share a region the
  // way two 4s could, and nine cells of board leave nothing to separate nine
  // cells of region with. No colouring exists — and the packer still may not
  // say so.
  Puzzle puzzle = test::board({"4.5", "...", "..."});
  paintClues(puzzle, kLight);
  const Outcome outcome = pack(puzzle);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_FALSE(outcome.proven);
}

/// The gate declines everything the construction does not model. Each of these
/// would otherwise be packed and then thrown away by the oracle.
TEST(Packing, DeclinesWhatItDoesNotModel) {
  // A rule: "every cell no region claimed takes the other colour" breaks all
  // but the emptiest rule set.
  Puzzle ruled = test::board({"2..2", "....", "...."}, test::ruleSet({Rule::NoDark2x2}));
  paintClues(ruled, kLight);
  EXPECT_FALSE(packing::applicable(buildModel(ruled)));

  // A clue that is not an area number.
  Puzzle dart = test::board({"2..2", "....", "...."});
  paintClues(dart, kLight);
  test::withDart(dart, 1, 1, 1, kDirUp);
  EXPECT_FALSE(packing::applicable(buildModel(dart)));

  // A merged cell: the packer packs squares.
  Puzzle merged = test::board({"2..2", "....", "...."});
  paintClues(merged, kLight);
  test::withShape(merged, {{0, 1}, {1, 1}});
  EXPECT_FALSE(packing::applicable(buildModel(merged)));

  // An unpainted clue cell: with the colour unknown, "everything else takes the
  // other colour" names no colour at all.
  Puzzle bare = test::board({"2..2", "....", "...."});
  EXPECT_FALSE(packing::applicable(buildModel(bare)));

  // Clue cells pinned to BOTH colours - a different construction, and no
  // captured board has asked for it yet.
  Puzzle mixed = test::board({"2..2", "....", "...."});
  paintClues(mixed, kLight);
  test::withGiven(mixed, 3, 0, kDark);
  EXPECT_FALSE(packing::applicable(buildModel(mixed)));

  // One clue has nothing to be kept apart from, so plain deduction has it.
  Puzzle lonely = test::board({"2..", "...", "..."});
  paintClues(lonely, kLight);
  EXPECT_FALSE(packing::applicable(buildModel(lonely)));

  // ...and the shape it does take.
  Puzzle fine = test::board({"2..2", "....", "...."});
  paintClues(fine, kLight);
  EXPECT_TRUE(packing::applicable(buildModel(fine)));
}

/// A given that carries no clue is not a decline: one in the clue colour is a
/// cell some region has to swallow, one in the other colour a square no region
/// may touch. Both are what the captured 12x12 looks like once a player has
/// worked part of it out by hand.
TEST(Packing, ReadsGivensThatCarryNoClue) {
  Puzzle mustCover = test::board({"2..2", "....", "...."});
  paintClues(mustCover, kLight);
  test::withGiven(mustCover, 1, 0, kLight);
  const Model model = buildModel(mustCover);
  ASSERT_TRUE(packing::applicable(model));
  const Outcome outcome = packing::runPacking(model, kCfg);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
  // The unclued light square joined the 2 beside it rather than being painted
  // over, which is the only way a colouring of this board verifies.
  EXPECT_EQ(outcome.colors[slot(cellIndex(1, 0))], kLight);
}

/// A cell the board paints the OTHER colour is a square no region may claim,
/// so a board that walls a clue in has no packing — and the arm still may not
/// call it unsolvable.
TEST(Packing, KeepsRegionsOffTheOtherColour) {
  Puzzle walled = test::board({"2..2", "....", "...."});
  paintClues(walled, kLight);
  test::withGiven(walled, 1, 0, kDark);
  test::withGiven(walled, 0, 1, kDark);
  const Model model = buildModel(walled);
  ASSERT_TRUE(packing::applicable(model));
  const Outcome outcome = packing::runPacking(model, kCfg);
  EXPECT_EQ(outcome.status, Status::Unsolved);
  EXPECT_FALSE(outcome.proven);
}

/**
 * The captured 12x12's shape in miniature: `areas` gives every dark region one
 * size, a letter pair pins one of them, and the numbers ask for the rest. A
 * letter carries no size of its own, so a board with letters and no instance is
 * declined rather than guessed at.
 */
TEST(Packing, PacksLetterGroupsAtTheSizeTheRuleGives) {
  Puzzle puzzle = test::board({"a.a.", "....", "3..."});
  test::withAreaRule(puzzle, kDark, 3);
  paintClues(puzzle, kDark);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(packing::applicable(model));
  const Outcome outcome = packing::runPacking(model, kCfg);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);

  Puzzle sizeless = test::board({"a.a.", "....", "3..."});
  paintClues(sizeless, kDark);
  EXPECT_FALSE(packing::applicable(buildModel(sizeless)));
}

/// Two different letters may never come out as one region however well the
/// sizes fit, which is the one thing a letter says that a number does not.
TEST(Packing, NeverJoinsTwoLetters) {
  Puzzle puzzle = test::board({"ab.", "...", "..."});
  test::withAreaRule(puzzle, kDark, 2);
  paintClues(puzzle, kDark);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(packing::applicable(model));
  const Outcome outcome = packing::runPacking(model, kCfg);
  // Adjacent cells of two letters cannot be two regions of two that do not
  // touch, so this board has no packing at all.
  EXPECT_EQ(outcome.status, Status::Unsolved);
}

/// The shape rule, which is a filter on what may be placed next rather than
/// anything the finished colouring is checked for. Two dark triominoes on a
/// 3x5, one straight and one bent, is the only reading `distinct-shapes` allows.
TEST(Packing, KeepsTwoRegionsFromTakingTheSameShape) {
  Puzzle puzzle =
      test::board({"3....", ".....", "....3"},
                  test::ruleSet({Rule::DistinctShapesDark}));
  test::withAreaRule(puzzle, kDark, 3);
  paintClues(puzzle, kDark);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(packing::applicable(model));
  const Outcome outcome = packing::runPacking(model, kCfg);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/// A shape rule on the colour the packing merely LEAVES OVER is declined: the
/// search steers none of those regions, so it could only build something the
/// oracle then throws away.
TEST(Packing, DeclinesAShapeRuleOnTheOtherColour) {
  Puzzle puzzle =
      test::board({"3....", ".....", "....3"},
                  test::ruleSet({Rule::DistinctShapesLight}));
  test::withAreaRule(puzzle, kDark, 3);
  paintClues(puzzle, kDark);
  EXPECT_FALSE(packing::applicable(buildModel(puzzle)));
}

/// `connect-light` is neither a filter nor an afterthought: the packer tests it
/// on the finished packing and backtracks, since a run of regions that cuts the
/// other colour in two is otherwise a perfectly good packing.
TEST(Packing, KeepsTheOtherColourInOnePiece) {
  Puzzle puzzle =
      test::board({".3.", "...", ".3."}, test::ruleSet({Rule::ConnectLight}));
  test::withAreaRule(puzzle, kDark, 3);
  paintClues(puzzle, kDark);
  const Model model = buildModel(puzzle);
  ASSERT_TRUE(packing::applicable(model));
  if (const Outcome outcome = packing::runPacking(model, kCfg);
      outcome.status == Status::Solved)
    EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
}

/// Dark clue cells are the same board mirrored, and the arm must not have
/// quietly assumed light anywhere.
TEST(Packing, PacksDarkCluesToo) {
  Puzzle puzzle = test::board({"2..2", "....", "...."});
  paintClues(puzzle, kDark);
  const Outcome outcome = pack(puzzle);
  ASSERT_EQ(outcome.status, Status::Solved);
  EXPECT_EQ(verify::check(buildModel(puzzle), outcome.colors),
            verify::Violation::None);
}

} // namespace
