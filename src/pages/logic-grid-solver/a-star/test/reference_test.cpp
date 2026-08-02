#include "TestBoards.h"

#include "Profile.h"
#include "Puzzle.h"
#include "Reference.h"
#include "Rules.h"
#include "Search.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <ostream>
#include <string>
#include <vector>

// The over-pruning net.
//
// `Verify` catches an answer that is not a solution. Nothing catches a
// propagator that quietly removes a colouring which WAS one — in normal mode
// that only shows up as a different valid answer, and in underclued mode it is
// a wrong answer that looks completely reasonable. So every board here is
// enumerated by brute force and the two are compared on the things that would
// differ: whether it is solvable at all, and exactly which cells are forced.
namespace {

using namespace lg;
using rules::Rule;

struct Case {
  std::string name;
  std::vector<std::string> picture;
  std::vector<Rule> rules;
};

/// gtest appends `# GetParam() = …` to every discovered name, and without this
/// it dumps the parameter's raw bytes — eighty hex pairs per test in the ctest
/// listing. Found through ADL because `Case` lives in this namespace, which is
/// also why it needs the attribute: nothing here names it, so an analyzer that
/// does not model gtest's universal printer reads it as dead code.
[[maybe_unused]] void PrintTo(const Case &value, std::ostream *out) {
  *out << value.name;
}

struct Shape {
  const char *name;
  std::vector<std::string> picture;
};

struct RuleSet {
  const char *name;
  std::vector<Rule> rules;
};

std::vector<Case> allCases() {
  using enum Rule;
  const std::vector<Shape> shapes = {
      {.name = "open", .picture = {"...", "...", "..."}},
      {.name = "gaps", .picture = {"..#", "...", "#.."}},
      {.name = "area", .picture = {"3..", "...", "..2"}},
      {.name = "twoAreas", .picture = {"2..", "...", "..2"}},
      {.name = "letter", .picture = {"a..", "...", "..a"}},
      {.name = "twoLetters", .picture = {"a.b", "...", "..."}},
      {.name = "givens", .picture = {"D..", "...", "..L"}},
      {.name = "mixed", .picture = {"3.b", ".#.", "b.2"}},
      {.name = "tall", .picture = {"..", "..", "..", ".."}},
      {.name = "ones", .picture = {"1.", ".1"}},
      // Five wide, so the 1x5 rules below have somewhere they can actually
      // fire. Every other shape here is at most four across in both directions,
      // which would have made that rule set a no-op against brute force.
      {.name = "wide", .picture = {".....", "....."}},
  };
  const std::vector<RuleSet> ruleSets = {
      {.name = "none", .rules = {}},
      {.name = "darkSquare", .rules = {NoDark2x2}},
      {.name = "bothSquares", .rules = {NoDark2x2, NoLight2x2}},
      {.name = "connectDark", .rules = {ConnectDark}},
      {.name = "connectBoth", .rules = {ConnectDark, ConnectLight}},
      {.name = "darkRun3", .rules = {NoDark1x3}},
      {.name = "lightPair", .rules = {NoLight1x2}},
      {.name = "checker", .rules = {NoCheckerboard}},
      {.name = "connectedSquares",
       .rules = {ConnectDark, ConnectLight, NoDark2x2, NoLight2x2}},
      {.name = "runsAndConnect", .rules = {ConnectDark, NoDark1x3}},
      {.name = "bothRuns5", .rules = {NoDark1x5, NoLight1x5}},
      {.name = "oneSymbolDark", .rules = {OneSymbolDark}},
      {.name = "oneSymbolBoth", .rules = {OneSymbolDark, OneSymbolLight}},
      {.name = "oneSymbolAndSquares",
       .rules = {OneSymbolDark, OneSymbolLight, NoDark2x2}},
  };

  std::vector<Case> cases;
  for (const auto &[shapeName, picture] : shapes) {
    for (const auto &[ruleSetName, ruleList] : ruleSets)
      cases.push_back({.name = std::string(shapeName) + "_" + ruleSetName,
                       .picture = picture,
                       .rules = ruleList});
  }
  return cases;
}

bool sameOnBoard(const Model &model, const Colors &left, const Colors &right) {
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (left[slot(i)] != right[slot(i)])
      return false;
  }
  return true;
}

class ReferenceTest : public testing::TestWithParam<Case> {};

TEST_P(ReferenceTest, EngineAgreesWithBruteForce) {
  const Case &one = GetParam();
  const Puzzle puzzle = test::board(one.picture, test::ruleSet(one.rules));
  ASSERT_EQ(structureProblem(puzzle), Problem::None);
  const Model model = buildModel(puzzle);

  const reference::Answer truth = reference::enumerate(model);
  ASSERT_TRUE(truth.ranToCompletion);

  constexpr Config cfg{.maxMs = 60000};
  const Outcome found = runDfs(model, cfg);
  const bool solvable = truth.solutionCount > 0;
  EXPECT_EQ(solvable, found.status == Status::Solved)
      << "brute force found " << truth.solutionCount << " solutions";
  if (!solvable) {
    EXPECT_EQ(found.status, Status::Unsolvable);
    return;
  }
  EXPECT_EQ(verify::check(model, found.colors), verify::Violation::None);

  // The profile sweep re-derives the rules in a second place, so it gets the
  // same treatment as the search: brute force decides, and the sweep has to
  // agree. A wrong transition here is the bug that would otherwise ship as a
  // confident wrong answer on exactly the boards nothing else can do.
  if (profile::applicable(model)) {
    const Outcome swept = profile::runProfile(model, cfg);
    EXPECT_EQ(swept.status,
              solvable ? Status::Solved : Status::Unsolvable)
        << "brute force found " << truth.solutionCount << " solutions";
    if (swept.status == Status::Solved) {
      EXPECT_EQ(verify::check(model, swept.colors), verify::Violation::None);
      EXPECT_EQ(swept.stats.oracleRejections, 0U);
    }
  }

  const Outcome forced = runForced(model, cfg);
  EXPECT_EQ(forced.status, Status::Deduced);
  EXPECT_TRUE(forced.proven);
  EXPECT_TRUE(sameOnBoard(model, forced.colors, truth.forced))
      << "engine " << test::draw(model, forced.colors).front() << " ...\n"
      << "truth  " << test::draw(model, truth.forced).front() << " ...";
  EXPECT_EQ(forced.stats.oracleRejections, 0U);
  for (const Colors &witness : forced.witnesses)
    EXPECT_EQ(verify::check(model, witness), verify::Violation::None);

  // The sweep answers the same question a completely different way — one
  // backward pass over an enumerated space, rather than a refutation search per
  // candidate cell — so it is held to the same standard: the EXACT forced set,
  // not merely a subset of it. A sweep that claims one cell too many is a
  // confidently wrong answer, and this is the only thing that would catch it.
  if (profile::applicable(model)) {
    const Outcome swept = profile::runProfileForced(model, cfg);
    EXPECT_EQ(swept.status, Status::Deduced);
    EXPECT_TRUE(swept.proven);
    EXPECT_TRUE(sameOnBoard(model, swept.colors, truth.forced))
        << "sweep " << test::draw(model, swept.colors).front() << " ...\n"
        << "truth " << test::draw(model, truth.forced).front() << " ...";
    EXPECT_EQ(swept.stats.oracleRejections, 0U);
    for (const Colors &witness : swept.witnesses)
      EXPECT_EQ(verify::check(model, witness), verify::Violation::None);
  }
}

INSTANTIATE_TEST_SUITE_P(
    LogicGrid, ReferenceTest, testing::ValuesIn(allCases()),
    [](const testing::TestParamInfo<Case> &info) { return info.param.name; });

} // namespace
