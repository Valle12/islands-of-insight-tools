#include "TestBoards.h"

#include "Profile.h"
#include "Puzzle.h"
#include "Reference.h"
#include "Rules.h"
#include "Search.h"
#include "Verify.h"

#include <gtest/gtest.h>
#include <cstddef>
#include <ostream>
#include <string>
#include <utility>
#include <vector>

// The over-pruning net.
//
// `Verify` catches an answer that is not a solution. Nothing catches a
// propagator that quietly removes a coloring which WAS one — in normal mode
// that only shows up as a different valid answer, and in underclued mode it is
// a wrong answer that looks completely reasonable. So every board here is
// enumerated by brute force and the two are compared on the things that would
// differ: whether it is solvable at all, and exactly which cells are forced.
namespace {

using namespace lg;
using rules::Rule;

/// Squares fused into one merged cell, as the picture cannot say it.
using Merge = std::vector<std::pair<int, int>>;

/// A dart, which the picture cannot say either: where it sits, how many of the
/// other color its line holds, and which way it points.
struct DartSpec {
  int x = 0;
  int y = 0;
  int value = 0;
  int direction = kDirRight;
};

/// A lotus: where it sits, which way its axis lies, and its seat.
struct LotusSpec {
  int x = 0;
  int y = 0;
  int axis = kAxisHorizontal;
  int seat = 0;
};

/// A viewpoint: where it sits and how many squares it must see, its own square
/// included. No direction — the four rays ARE the clue.
struct ViewpointSpec {
  int x = 0;
  int y = 0;
  int value = 1;
};

/// A galaxy: where it sits, and where inside its square the center of the turn
/// sits — 0 the square's own center, 1 and 2 the edges to the right and below,
/// 3 the corner. No value and no direction.
struct GalaxySpec {
  int x = 0;
  int y = 0;
  int seat = 0;
};

struct Case {
  std::string name;
  std::vector<std::string> picture;
  std::vector<Rule> rules;
  /// Sized instances stated directly — the sizes the v1 enum never had. The
  /// legacy `rules` lists keep saying names like `AreaTwoDark`; `puzzleFor`
  /// translates those into instances too, so both spellings referee the same
  /// machinery.
  std::vector<rules::SizedRule> areas;
  std::vector<rules::SizedRule> runs;
  /// Forbidden arrangements stated as drawings — the shapes no rule names any
  /// more, plus ones no rule ever named. Like the sized instances above, the
  /// legacy `rules` lists translate into these too where they name one of the
  /// ten retired arrangements.
  std::vector<rules::DrawnPattern> patterns;
  std::vector<Merge> merges;
  std::vector<DartSpec> darts;
  std::vector<LotusSpec> lotuses;
  std::vector<ViewpointSpec> viewpoints;
  std::vector<GalaxySpec> galaxies;
};

/// gtest appends `# GetParam() = …` to every discovered name, and without this
/// it dumps the parameter's raw bytes — eighty hex pairs per test in the ctest
/// listing. Found through ADL because `Case` lives in this namespace, which is
/// also why it needs the attribute: nothing here names it, so an analyzer that
/// does not model gtest's universal printer reads it as dead code.
[[maybe_unused]] void PrintTo(const Case &value, std::ostream *out) {
  *out << value.name;
}

/// A board OUTLINE — its gaps, givens and clues. Named `Board` rather than
/// `Shape` because a shape is now a merged cell, which is the `merges` field.
struct Board {
  const char *name;
  std::vector<std::string> picture;
  std::vector<Merge> merges;
  std::vector<DartSpec> darts;
  std::vector<LotusSpec> lotuses;
  std::vector<ViewpointSpec> viewpoints;
  std::vector<GalaxySpec> galaxies;
};

struct RuleSet {
  const char *name;
  std::vector<Rule> rules;
  std::vector<rules::SizedRule> areas;
  std::vector<rules::SizedRule> runs;
  std::vector<rules::DrawnPattern> patterns;
};

std::vector<Case> allCases() {
  using enum Rule;
  const std::vector<Board> boards = {
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
      // And six wide, for the area-five pair: an area of five implies a
      // forbidden run of SIX, which no other board here has room to hold. Two
      // rows keep the enumeration at 2^12.
      {.name = "wide6", .picture = {"......", "......"}},
      // Merged cells. Everything about them lives on the VARIABLE side — the
      // rules still read the square grid — so what has to be checked is that
      // fusing squares removes exactly the colorings that split a cell and no
      // others. Nothing at runtime could tell those two apart.
      {.name = "bar",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {1, 0}, {2, 0}}}},
      {.name = "domino",
       .picture = {"..", "..", ".."},
       .merges = {{{0, 0}, {0, 1}}}},
      // An L spanning a checkerboard's diagonal, which is the instance the
      // clause compiler DROPS rather than collapses.
      {.name = "ell",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {1, 0}, {1, 1}}}},
      // A clue on a merged cell: its region starts at two squares rather than
      // one, and its only ways to grow are whole cells.
      {.name = "cluedCell",
       .picture = {"3..", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}}},
      // Two adjacent merged cells, so `mergeAround`'s border scan really does
      // meet one region through two different squares.
      {.name = "twoCells",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {0, 1}}, {{1, 0}, {1, 1}}}},
      // Darts. Their propagator paints from a counting argument in BOTH
      // directions — "taking this cell would overshoot" and "leaving it out
      // would undershoot" — and an over-eager one of those removes real
      // solutions, which nothing at runtime can see.
      {.name = "dart",
       .picture = {"...", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirRight}}},
      // Zero and full: the two ends that fill in immediately, and the two the
      // propagator paints hardest at.
      {.name = "dartZero",
       .picture = {"...", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 0, .direction = kDirDown}}},
      {.name = "dartFull",
       .picture = {"...", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 2, .direction = kDirRight}}},
      // A line crossing a gap, which it steps over rather than stopping at.
      {.name = "dartGap",
       .picture = {".#.", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirRight}}},
      // Two darts on one line, aimed the same way — the shape the game's
      // "overloading darts" technique is about, and the one a pairwise
      // propagator would have to get exactly right.
      {.name = "twoDarts",
       .picture = {"....", "....", "...."},
       .darts = {{.x = 0, .y = 0, .value = 2, .direction = kDirRight},
                 {.x = 1, .y = 0, .value = 1, .direction = kDirRight}}},
      // A dart ON a merged cell: its line starts at the square it sits on and
      // its own cell is taken out of it.
      {.name = "dartOnCell",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {0, 1}}},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirRight}}},
      // ...and a merged cell ACROSS one, which the line counts once per square.
      {.name = "dartOverCell",
       .picture = {"...", "...", "..."},
       .merges = {{{1, 0}, {2, 0}}},
       .darts = {{.x = 0, .y = 0, .value = 2, .direction = kDirRight}}},
      // Darts whose OWN square the board paints, which is the only shape the
      // profile sweep will take one in: what a dart counts is the opposite of
      // its own color, so a painted one is a fixed target and the sweep can
      // carry a running count for it. These three are what referee that count
      // — the sweep reads the ray a completely different way from the
      // propagator, one cell at a time in scan order, and a miscount would
      // otherwise ship as a confident wrong forced set.
      {.name = "dartOnLight",
       .picture = {"L..", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirRight}}},
      // On a DARK square, so the ray counts light cells — the reading the
      // sweep takes as "the rest of the ray" rather than counting directly.
      {.name = "dartOnDark",
       .picture = {"D..", "...", "..."},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirDown}}},
      // Two painted darts crossing each other's line, so both counters are
      // live at once over cells each of them counts.
      {.name = "twoDartsPainted",
       .picture = {"L..", "L..", "..."},
       .darts = {{.x = 0, .y = 0, .value = 2, .direction = kDirRight},
                 {.x = 0, .y = 1, .value = 1, .direction = kDirRight}}},
      // Lotuses. The propagator paints (the mirror of everything connected to
      // the lotus through decided cells) and refuses (cells whose reflection
      // can never match), and over-doing EITHER removes real solutions —
      // invisible at runtime, which is this suite's whole reason to exist.
      {.name = "lotus",
       .picture = {"...", "...", "..."},
       .lotuses = {{.x = 1, .y = 1, .axis = kAxisHorizontal}}},
      {.name = "lotusDiagonal",
       .picture = {"...", "...", "..."},
       .lotuses = {{.x = 1, .y = 1, .axis = kAxisDiagonalDown}}},
      // Off-center, so most of the board reflects off an edge — the heaviest
      // use of the "opposing nulls" refusal.
      {.name = "lotusEdge",
       .picture = {"...", "...", "..."},
       .lotuses = {{.x = 0, .y = 0, .axis = kAxisVertical}}},
      // Two parallel axes: connected they would force a translation, which no
      // finite region survives — the game's "connection restriction", here as
      // an emergent fact brute force gets to referee.
      {.name = "twoLotuses",
       .picture = {"...", "...", "..."},
       .lotuses = {{.x = 1, .y = 0, .axis = kAxisHorizontal},
                   {.x = 1, .y = 2, .axis = kAxisHorizontal}}},
      // A seat on the seam of a 1x2 cell: the axis is a grid line.
      {.name = "lotusSeat",
       .picture = {"..", "..", ".."},
       .merges = {{{0, 0}, {0, 1}}},
       .lotuses = {{.x = 0, .y = 0, .axis = kAxisHorizontal, .seat = 2}}},
      // Viewpoints. The propagator brackets every ray between "already seen"
      // and "could still see" and forces in both directions off the bracket —
      // over-doing either removes real solutions, which only this suite sees.
      {.name = "viewpoint",
       .picture = {"...", "...", "..."},
       .viewpoints = {{.x = 0, .y = 0, .value = 3}}},
      // The whole cross of the center square — the game's "maximal viewpoint",
      // where every ray must be seen out to its end.
      {.name = "viewpointMax",
       .picture = {"...", "...", "..."},
       .viewpoints = {{.x = 1, .y = 1, .value = 5}}},
      // Sight stops at the gap, where a dart's line steps over it.
      {.name = "viewpointGap",
       .picture = {".#.", "...", "..."},
       .viewpoints = {{.x = 0, .y = 0, .value = 3}}},
      // Two viewpoints that can see each other — the game's "perpendicular
      // viewpoints" technique, emergent from the counting meeting itself, and
      // brute force referees the interplay.
      {.name = "twoViewpoints",
       .picture = {"...", "...", "..."},
       .viewpoints = {{.x = 0, .y = 1, .value = 3},
                      {.x = 2, .y = 1, .value = 2}}},
      // A viewpoint ON a merged cell: its own squares count only where a ray
      // crosses them — the vertical domino puts one own square on the down
      // ray, so the count can never be below two.
      {.name = "viewpointOnCell",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {0, 1}}},
       .viewpoints = {{.x = 0, .y = 0, .value = 2}}},
      // ...and a merged cell ACROSS a ray, counted once per square crossed.
      {.name = "viewpointOverCell",
       .picture = {"...", "...", "..."},
       .merges = {{{1, 0}, {2, 0}}},
       .viewpoints = {{.x = 0, .y = 0, .value = 3}}},
      // A viewpoint of ONE: the collapse case under off-by-one — its displayed
      // 0 twin cannot join this roster, since a 0 is only legal WITH the rule
      // and every board here runs under every rule set.
      {.name = "viewpointOne",
       .picture = {"...", "...", "..."},
       .viewpoints = {{.x = 1, .y = 1, .value = 1}}},
      // Seven wide: the first board an area-six implied run of SEVEN can even
      // instantiate on. Deliberately no 8x2 sibling — 2^16 per rule set is
      // real money, and the run-of-eight is pinned in rules_test and crossed
      // through the wasm boundary instead.
      {.name = "wide7", .picture = {".......", "......."}},
      // Two area clues whose displayed values differ by exactly two — the
      // off-by-2 trick's board. Legal under EVERY rule set here: without
      // off-by-one they are honest counts in separate corners.
      {.name = "areasOffByTwo", .picture = {"1..", "...", "..3"}},
      // Galaxies. The propagator is the lotus's shared fold under a point
      // mirror, and over-doing either half removes real solutions only this
      // suite can see.
      {.name = "galaxy",
       .picture = {"...", "...", "..."},
       .galaxies = {{.x = 1, .y = 1}}},
      // Off-center, so most of the board turns off an edge — the heaviest use
      // of the opposing-nulls refusal, the lotusEdge of the half turn.
      {.name = "galaxyEdge",
       .picture = {"...", "...", "..."},
       .galaxies = {{.x = 0, .y = 0}}},
      // Two galaxies: connected they would compose to a translation no finite
      // region survives — the "galaxies cannot touch" theorem, deliberately
      // coded nowhere, with brute force as its referee.
      {.name = "twoGalaxies",
       .picture = {"...", "...", "..."},
       .galaxies = {{.x = 1, .y = 0}, {.x = 1, .y = 2}}},
      // A galaxy ON a merged cell: the mirror is about its own SQUARE, and its
      // cell-mate must land somewhere playable — here it does.
      {.name = "galaxyOnCell",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}},
       .galaxies = {{.x = 1, .y = 0}}},
      // ...and a merged cell inside the mirrored REGION rather than under the
      // clue itself.
      {.name = "galaxyOverCell",
       .picture = {"...", "...", "..."},
       .merges = {{{1, 0}, {2, 0}}},
       .galaxies = {{.x = 0, .y = 0}}},
      // The own-cell mirror off the board: every coloring fuses the cell into
      // the galaxy's region and its far square turns past the edge, so brute
      // force must count zero solutions and the engine must agree.
      {.name = "galaxyOffCell",
       .picture = {"..."},
       .merges = {{{0, 0}, {1, 0}}},
       .galaxies = {{.x = 0, .y = 0}}},
      // SEATED galaxies: the center on a grid line or a corner, where the turn
      // carries a SIGN and may INVERT color. The propagator reads that sign
      // off the squares around the center and folds every region touching it,
      // so a sign taken too eagerly — or a region left unwalked — removes real
      // solutions that only this suite can see.
      {.name = "galaxySeam",
       .picture = {"...", "...", "..."},
       .galaxies = {{.x = 0, .y = 1, .seat = 1}}},
      {.name = "galaxyCorner",
       .picture = {"...", "...", "..."},
       .galaxies = {{.x = 0, .y = 0, .seat = 3}}},
      // A seam centered so the turn maps the whole board onto itself, which is
      // where an inverting sign has the most to say.
      {.name = "galaxyFold",
       .picture = {"..", "..", "..", ".."},
       .galaxies = {{.x = 0, .y = 1, .seat = 3}}},
      // A seated galaxy whose seat crosses a merged cell's seam — the case the
      // lotus refuses and this one allows.
      {.name = "galaxySeamOverCell",
       .picture = {"...", "...", "..."},
       .merges = {{{1, 1}, {2, 1}}},
       .galaxies = {{.x = 0, .y = 1, .seat = 1}}},
      // A merged cell may carry SEVERAL clues, one per square — the game's
      // harder boards put two darts on one domino. The next five are that
      // capability across the kinds, brute force refereeing what each
      // combination really admits.
      {.name = "twoDartsOneCell",
       .picture = {"...", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}},
       .darts = {{.x = 0, .y = 0, .value = 1, .direction = kDirRight},
                 {.x = 1, .y = 0, .value = 1, .direction = kDirDown}}},
      // Two area numbers that AGREE about their shared region.
      {.name = "twoAreasOneCell",
       .picture = {"22.", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}}},
      // ...and two that cannot both be exact: one region cannot have area 2
      // and 4 at once, so plain rule sets must count zero solutions — while
      // under off-by-one the candidate sets {1,3} and {3,5} intersect at 3,
      // the off-by-2 trick landing on a single CELL.
      {.name = "areasDisagreeOnCell",
       .picture = {"24.", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}}},
      // Two different letters welded together can never sit in different
      // regions: zero solutions, reached by search rather than by structure.
      {.name = "twoLettersOneCell",
       .picture = {"ab.", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}}},
      // Mixed kinds on one cell are legal and solvable.
      {.name = "dartAndLetterOneCell",
       .picture = {"a..", "...", "..."},
       .merges = {{{0, 0}, {1, 0}}},
       .darts = {{.x = 1, .y = 0, .value = 1, .direction = kDirDown}}},
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
      // The area rules are the first whose propagator paints from a "must be at
      // least this big" argument, and over-pruning one of those is invisible at
      // runtime — `Verify` catches an answer that is not a solution, never a
      // solution that was thrown away. This is the only thing that would.
      {.name = "areaTwoDark", .rules = {AreaTwoDark}},
      {.name = "areaTwoBoth", .rules = {AreaTwoDark, AreaTwoLight}},
      {.name = "areaTwoAndConnect", .rules = {AreaTwoDark, ConnectLight}},
      // An area rule beside a run rule is the one combination where pattern
      // generation does something derived — `impliedRun` folds "an area of two
      // forbids a run of three" in, so these two decide whether the shortest
      // run is the rule's or the implication's. The second is the degenerate
      // end of it: a forbidden PAIR subsumes every tromino, and dark then has
      // to be empty.
      {.name = "areaTwoAndRun3", .rules = {AreaTwoDark, NoDark1x3}},
      {.name = "areaTwoAndPair", .rules = {AreaTwoDark, NoDark1x2}},
      // Area FOUR, whose "too big" half has no forbidden shapes behind it at
      // all — `regionArea` is the whole rule — so brute force is the only thing
      // that can tell an over-eager region walk from a correct one.
      {.name = "areaFourDark", .rules = {AreaFourDark}},
      {.name = "areaFourBoth", .rules = {AreaFourDark, AreaFourLight}},
      {.name = "areaFourAndConnect", .rules = {AreaFourDark, ConnectLight}},
      // Both sizes on one color: legal, and satisfied exactly where that
      // color is absent. Worth enumerating precisely because it looks like a
      // contradiction and is not.
      {.name = "areaTwoAndFourDark", .rules = {AreaTwoDark, AreaFourDark}},
      // Area FIVE: the same walk as four, at the first size whose implied run
      // — six cells — forced the pattern table wider. The run-3 pairing is the
      // implication fold at this size, where the direct rule wins the min.
      {.name = "areaFiveDark", .rules = {AreaFiveDark}},
      {.name = "areaFiveBoth", .rules = {AreaFiveDark, AreaFiveLight}},
      {.name = "areaFiveAndConnect", .rules = {AreaFiveDark, ConnectLight}},
      {.name = "areaFiveAndRun3", .rules = {AreaFiveDark, NoDark1x3}},
      // The mixed-color triples and the T — the first table rules to name
      // both colors since the checkerboard, and the first with a subsumption
      // of their own. `tWithRun3` and `tWithAreaTwo` are the subsumed cases:
      // the T patterns are dropped there, and brute force is what proves that
      // dropping them removed no coloring a full table would have kept.
      {.name = "noDLD", .rules = {NoDarkLightDark}},
      {.name = "bothTriples", .rules = {NoDarkLightDark, NoLightDarkLight}},
      {.name = "tripleAndConnect", .rules = {NoDarkLightDark, ConnectDark}},
      {.name = "noDarkT", .rules = {NoDarkT}},
      {.name = "bothTees", .rules = {NoDarkT, NoLightT}},
      {.name = "tWithRun3", .rules = {NoDarkT, NoDark1x3}},
      {.name = "tWithAreaTwo", .rules = {NoDarkT, AreaTwoDark}},
      {.name = "teeAndTriple", .rules = {NoDarkT, NoLightDarkLight}},
      // The 3+1 rules and the three subsumptions each has to prove sound: a
      // pair rule, an area of exactly two and the color's diagonal rule all
      // drop the 3+1 instances. `threeOneWithAreaThree` is the near-miss where
      // dropping would be WRONG — an area of three lays out no trominoes, and
      // a bent dark region of three with the odd corner light is legal
      // everywhere except under this rule.
      {.name = "threeOneDark", .rules = {NoThreeDarkOneLight}},
      {.name = "threeOneBoth",
       .rules = {NoThreeDarkOneLight, NoThreeLightOneDark}},
      {.name = "threeOneWithPair", .rules = {NoThreeDarkOneLight, NoDark1x2}},
      {.name = "threeOneWithAreaTwo",
       .rules = {NoThreeDarkOneLight, AreaTwoDark}},
      {.name = "threeOneWithAreaThree",
       .rules = {NoThreeDarkOneLight, AreaThreeDark}},
      {.name = "threeOneWithDiagonal",
       .rules = {NoThreeDarkOneLight, NoDarkDiagonal}},
      // The diagonal rules, whose two-cell clauses subsume the square, the T,
      // the bent trominoes and the checkerboard — each pairing proves its drop
      // kept every coloring, and the lightSquare one that the drop stays on
      // its own color. `diagonalAndConnect` is the shape the rule plays in
      // the game: straight bars that must also form one region.
      {.name = "diagonalDark", .rules = {NoDarkDiagonal}},
      {.name = "diagonalBoth", .rules = {NoDarkDiagonal, NoLightDiagonal}},
      {.name = "diagonalAndConnect", .rules = {NoDarkDiagonal, ConnectDark}},
      {.name = "diagonalWithSquares", .rules = {NoDarkDiagonal, NoDark2x2}},
      {.name = "diagonalWithLightSquare",
       .rules = {NoDarkDiagonal, NoLight2x2}},
      {.name = "diagonalWithTee", .rules = {NoDarkDiagonal, NoDarkT}},
      {.name = "diagonalWithAreaTwo", .rules = {NoDarkDiagonal, AreaTwoDark}},
      {.name = "diagonalWithChecker",
       .rules = {NoDarkDiagonal, NoCheckerboard}},
      // Area THREE: `regionArea` again, at a size the table keeps no shapes
      // for beyond the implied run of four.
      {.name = "areaThreeDark", .rules = {AreaThreeDark}},
      {.name = "areaThreeBoth", .rules = {AreaThreeDark, AreaThreeLight}},
      {.name = "areaThreeAndConnect", .rules = {AreaThreeDark, ConnectLight}},
      // The elbow rules and their gates: the area-two pairing is the DEDUP
      // (both would lay the same four shapes), area-three the near-miss where
      // dropping would be wrong, and the pair/diagonal pairings the ordinary
      // subsumptions.
      {.name = "elbowDark", .rules = {NoDarkElbow}},
      {.name = "elbowBoth", .rules = {NoDarkElbow, NoLightElbow}},
      {.name = "elbowWithAreaTwo", .rules = {NoDarkElbow, AreaTwoDark}},
      {.name = "elbowWithAreaThree", .rules = {NoDarkElbow, AreaThreeDark}},
      {.name = "elbowWithDiagonal", .rules = {NoDarkElbow, NoDarkDiagonal}},
      {.name = "elbowWithPair", .rules = {NoDarkElbow, NoDark1x2}},
      // The L rules: both handednesses compiled, and every gate proved to
      // keep all the colorings a full table would — the area-four pairing is
      // the near-miss where an L-shaped region of four is legal.
      {.name = "ellDark", .rules = {NoDarkEll}},
      {.name = "ellBoth", .rules = {NoDarkEll, NoLightEll}},
      {.name = "ellWithRun3", .rules = {NoDarkEll, NoDark1x3}},
      {.name = "ellWithElbow", .rules = {NoDarkEll, NoDarkElbow}},
      {.name = "ellWithKnight", .rules = {NoDarkEll, NoDarkKnight}},
      {.name = "ellWithAreaFour", .rules = {NoDarkEll, AreaFourDark}},
      // The distance rules — the first patterns that fire across a gap, which
      // the `gaps` and `dartGap` boards above exercise directly — and the
      // rules they newly subsume: the long runs and the triples, but never
      // the domino.
      {.name = "distanceDark", .rules = {NoDarkAnyDark}},
      {.name = "distanceBoth", .rules = {NoDarkAnyDark, NoLightAnyLight}},
      {.name = "distanceWithRun3", .rules = {NoDarkAnyDark, NoDark1x3}},
      {.name = "distanceWithPair", .rules = {NoDarkAnyDark, NoDark1x2}},
      {.name = "distanceWithTriple",
       .rules = {NoDarkAnyDark, NoDarkLightDark}},
      {.name = "distanceAndConnect", .rules = {NoDarkAnyDark, ConnectDark}},
      // The long T, subsumed six ways over; the area-five pairing is its
      // near-miss, a long-T region of exactly five being legal under it.
      {.name = "longTeeDark", .rules = {NoDarkLongT}},
      {.name = "longTeeWithTee", .rules = {NoDarkLongT, NoDarkT}},
      {.name = "longTeeWithEll", .rules = {NoDarkLongT, NoDarkEll}},
      {.name = "longTeeWithAreaFive", .rules = {NoDarkLongT, AreaFiveDark}},
      // The knight rules — subsumed by nothing, subsuming the L and long T.
      {.name = "knightDark", .rules = {NoDarkKnight}},
      {.name = "knightBoth", .rules = {NoDarkKnight, NoLightKnight}},
      {.name = "knightWithDiagonal", .rules = {NoDarkKnight, NoDarkDiagonal}},
      // The mixed T — its bar IS a triple, its ends a distance pair, and one
      // arm-crossing-stem corner a mixed elbow, so each pairing proves a drop.
      {.name = "mixedTeeDark", .rules = {NoLightCrossedDarkT}},
      {.name = "mixedTeeBoth",
       .rules = {NoLightCrossedDarkT, NoDarkCrossedLightT}},
      {.name = "mixedTeeWithTriple",
       .rules = {NoLightCrossedDarkT, NoDarkLightDark}},
      {.name = "mixedTeeWithMixedElbow",
       .rules = {NoLightCrossedDarkT, NoDarkLightDarkElbow}},
      // The mixed elbow — subsumed only by its ENDS' diagonal rule, and newly
      // subsuming the 3+1 and the checkerboard.
      {.name = "mixedElbowDark", .rules = {NoDarkLightDarkElbow}},
      {.name = "mixedElbowBoth",
       .rules = {NoDarkLightDarkElbow, NoLightDarkLightElbow}},
      {.name = "mixedElbowWithDiagonal",
       .rules = {NoDarkLightDarkElbow, NoDarkDiagonal}},
      {.name = "mixedElbowWithThreeOne",
       .rules = {NoThreeDarkOneLight, NoDarkLightDarkElbow}},
      {.name = "mixedElbowWithChecker",
       .rules = {NoDarkLightDarkElbow, NoCheckerboard}},
      // The larger areas. Six is the first size whose implied run of seven
      // fits only the wide7 board; twenty-four degenerates to "the color is
      // absent" on every board here, and BOTH at twenty-four is unsolvable
      // everywhere — every cell needs a color — which is exactly worth
      // sweeping because it looks like a special case and is not one.
      {.name = "areaSixDark", .rules = {AreaSixDark}},
      {.name = "areaSixBoth", .rules = {AreaSixDark, AreaSixLight}},
      {.name = "areaSevenDark", .rules = {AreaSevenDark}},
      {.name = "areaTwentyFourDark", .rules = {AreaTwentyFourDark}},
      {.name = "areaTwentyFourBoth",
       .rules = {AreaTwentyFourDark, AreaTwentyFourLight}},
      // Off-by-one: every numeric clue's displayed value bent by one, with
      // the connect pairing driving `cardinality`, the one-symbol pairing
      // `clueReach`, and the area-two pairing `mergeLimits` — each of them a
      // candidate-set consumer with its own way to over-prune.
      {.name = "offByOne", .rules = {OffByOne}},
      {.name = "offByOneAndConnect", .rules = {OffByOne, ConnectDark}},
      {.name = "offByOneOneSymbol", .rules = {OffByOne, OneSymbolDark}},
      {.name = "offByOneAreaTwo", .rules = {OffByOne, AreaTwoDark}},
      // The collinearity emission (connect + elbow => every off-axis pair)
      // and the border-arc propagator (both connects => two perimeter arcs).
      // Both are derived facts whose over-pruning nothing at runtime could
      // catch, which is exactly what this sweep exists for.
      {.name = "elbowAndConnect", .rules = {NoDarkElbow, ConnectDark}},
      {.name = "elbowLightAndConnect", .rules = {NoLightElbow, ConnectLight}},
      {.name = "elbowAndConnectBoth",
       .rules = {NoDarkElbow, ConnectDark, ConnectLight}},
      {.name = "teeAndConnectBoth",
       .rules = {NoDarkT, ConnectDark, ConnectLight}},
      // Area ONE — the size the v1 catalog never had, and the reason
      // `regionArea` grew a gate: its isolated-singleton sweep would exclude
      // the very shape this rule wants, and ONLY brute force can tell that
      // over-pruning from correct propagation. Both colors at once forces a
      // perfect checkerboard on an open board — two solutions, an empty
      // forced set — and on the `givens` board it is unsolvable outright,
      // its two given corners sharing a parity class. The connect pairing
      // runs the singleton against `mergeLimits`' smallest-area bound.
      {.name = "areaOneDark", .areas = {{.color = kDark, .value = 1}}},
      {.name = "areaOneBoth",
       .areas = {{.color = kDark, .value = 1},
                 {.color = kLight, .value = 1}}},
      {.name = "areaOneAndConnect",
       .rules = {ConnectLight},
       .areas = {{.color = kDark, .value = 1}}},
      // A run instance of SIX — past the v1 ladder, spelled directly as a
      // value. Only the wide7 board can even instantiate it; everywhere else
      // it must be a proven no-op, which is exactly a referee's question.
      {.name = "runSixDark", .runs = {{.color = kDark, .value = 6}}},
      // An area-one/area-two mix on ONE color: satisfied only where dark is
      // absent, like every same-color pair, but reached through the area-one
      // gate rather than around it.
      {.name = "areaOneAndTwoDark",
       .areas = {{.color = kDark, .value = 1}, {.color = kDark, .value = 2}}},
      // The SHAPE rules, and this sweep is the only thing that can referee
      // them: their propagator paints from "this open region has to grow" and
      // from a target shape DERIVED from whichever region closed first, and
      // `Verify` can only catch an answer that is not a solution, never a
      // solution that was thrown away. The near misses it has to prove sound
      // are two open congruent regions (which may still grow apart, or merge)
      // and an open region matching a closed one with more than one way out.
      {.name = "distinctDark", .rules = {DistinctShapesDark}},
      {.name = "distinctBoth",
       .rules = {DistinctShapesDark, DistinctShapesLight}},
      {.name = "distinctAndConnect", .rules = {DistinctShapesDark, ConnectLight}},
      {.name = "sameShapeDark", .rules = {SameShapeDark}},
      {.name = "sameShapeBoth", .rules = {SameShapeDark, SameShapeLight}},
      // Connect makes dark ONE region, so the rule holds vacuously — and the
      // propagator must not deduce anything from a target it never gets.
      {.name = "sameShapeAndConnect", .rules = {SameShapeDark, ConnectDark}},
      // `sameShape` borrows `regionArea` once a region closes, so the pairing
      // with a real area instance is where a doubled or disagreeing size would
      // show. Area ONE is the gate `regionArea` guards with `area >= 2`.
      {.name = "sameShapeAndAreaTwo",
       .rules = {SameShapeDark},
       .areas = {{.color = kDark, .value = 2}}},
      {.name = "sameShapeAndAreaOne",
       .rules = {SameShapeDark},
       .areas = {{.color = kDark, .value = 1}}},
      // Distinct plus an area of one says dark holds AT MOST ONE cell, and
      // distinct plus same-shape says it has at most one region. Both are
      // derived facts nothing codes, so brute force is what checks them.
      {.name = "distinctAndAreaOne",
       .rules = {DistinctShapesDark},
       .areas = {{.color = kDark, .value = 1}}},
      {.name = "distinctAndSameDark",
       .rules = {DistinctShapesDark, SameShapeDark}},
      // The drawn patterns. `Verify` gates every complete answer, so the thing
      // brute force is here for is the SWEEP: `profile::applicable` admits a
      // board carrying these, and `planPatterns` has to compile them in.
      // Miss that and the sweep walks a superset of the solutions and reports
      // the cells they disagree about as PROVEN, which nothing else catches.
      //
      // A 2x2 drawn as a pattern, which is also the shape the smallest built-in
      // rule names — so this is the pair where a drawn clause and a rule clause
      // both fire, and neither may prune what the other does not.
      {.name = "drawnSquare",
       .patterns = {test::pattern({"DD", "DD"})}},
      {.name = "drawnSquareAndRule",
       .rules = {NoDark2x2},
       .patterns = {test::pattern({"DD", "DD"})}},
      // Connect is the sweep's other admitted rule, and the combination is
      // what a real underclued board looks like.
      {.name = "drawnSquareAndConnect",
       .rules = {ConnectDark},
       .patterns = {test::pattern({"DD", "DD"})}},
      {.name = "drawnSquareUnderclued",
       .rules = {Underclued},
       .patterns = {test::pattern({"DD", "DD"})}},
      // An area instance makes `applicable` DECLINE, so this pair checks the
      // search path with a pattern the sweep never sees.
      {.name = "drawnSquareAndAreaTwo",
       .areas = {{.color = kDark, .value = 2}},
       .patterns = {test::pattern({"DD", "DD"})}},
      // Two colors in one shape, which only a drawn pattern can state now
      // that the mixed elbow is retired — and the shape the migration writes
      // for rule 51, so this is that rule refereed by brute force.
      {.name = "drawnMixedElbow", .patterns = {test::pattern({"LD", "D."})}},
      // A square the pattern does NOT name, between two it does: the clause
      // has to fire across it, gap or no gap.
      {.name = "drawnKnight",
       .patterns = {test::pattern({"D.", "..", ".D"})}},
      // Two patterns at once, in canonical order, and of different colors.
      {.name = "drawnTwo",
       .patterns = {test::pattern({"D.", ".D"}),
                    test::pattern({"L.", "..", ".L"})}},
      // Three rows tall on a three-wide board, so the arrangement reaches
      // further back than the frontier holds and `planOf` has to decline the
      // sweep rather than read a truncated distance.
      {.name = "drawnTall",
       .patterns = {test::pattern({"D..", "...", "..D"})}},
      // A pattern naming ONE square: "no dark cell at all". Degenerate but
      // legal, and the unit clause is the sharpest thing the propagator does.
      {.name = "drawnSingle", .patterns = {test::pattern({"D"})}},
  };

  std::vector<Case> cases;
  for (const auto &[boardName, picture, merges, darts, lotuses, viewpoints,
                    galaxies] : boards) {
    for (const auto &[ruleSetName, ruleList, areaList, runList, patternList] :
         ruleSets)
      cases.push_back({.name = std::string(boardName) + "_" + ruleSetName,
                       .picture = picture,
                       .rules = ruleList,
                       .areas = areaList,
                       .runs = runList,
                       .patterns = patternList,
                       .merges = merges,
                       .darts = darts,
                       .lotuses = lotuses,
                       .viewpoints = viewpoints,
                       .galaxies = galaxies});
  }
  return cases;
}

Puzzle puzzleFor(const Case &one) {
  // The legacy rule lists still say names like `AreaTwoDark`; the sized ones
  // become `areas`/`runs` instances through the same translation the CLI's
  // `--rules` speaks, so every historical sweep keeps refereeing exactly the
  // constraint it always did. Direct instances are layered on top through the
  // canonical-insert helpers.
  rules::RuleMask legacy = 0;
  for (const Rule rule : one.rules)
    legacy |= rules::bit(rule);
  // Named apart from `one.areas`/`one.runs`, which are the DIRECT instances
  // layered on next and mean something else.
  auto [splitFlags, splitAreas, splitRuns, splitPatterns] =
      rules::splitLegacyMask(legacy);
  Puzzle puzzle = test::board(one.picture, splitFlags);
  puzzle.areas = std::move(splitAreas);
  puzzle.runs = std::move(splitRuns);
  puzzle.patterns = std::move(splitPatterns);
  for (const rules::DrawnPattern &drawn : one.patterns)
    test::withPattern(puzzle, drawn);
  for (const auto &[color, value] : one.areas)
    test::withAreaRule(puzzle, color, value);
  for (const auto &[color, value] : one.runs)
    test::withRunRule(puzzle, color, value);
  for (const Merge &merge : one.merges)
    test::withShape(puzzle, merge);
  for (const auto &[x, y, value, direction] : one.darts)
    test::withDart(puzzle, x, y, value, direction);
  for (const auto &[x, y, axis, seat] : one.lotuses)
    test::withLotus(puzzle, x, y, axis, seat);
  for (const auto &[x, y, value] : one.viewpoints)
    test::withViewpoint(puzzle, x, y, value);
  for (const auto &[x, y, seat] : one.galaxies)
    test::withGalaxy(puzzle, x, y, seat);
  return puzzle;
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
  const Puzzle puzzle = puzzleFor(one);
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

/**
 * Brute force is only a net if it enumerates the same space the engine does.
 * It now enumerates one bit per CELL, which is a claim about `representatives`
 * and `cellMask` — so pin that claim against something that knows only about
 * squares: sweep every coloring of the SQUARES, keep the ones the oracle
 * accepts, and the survivors must be exactly what `enumerate` produced.
 *
 * This is what makes `Verify::fusedProblem` and `Model::cellMask` mutually
 * load-bearing. Drop the oracle check and the square sweep finds colorings
 * that split a cell; get `cellMask` wrong and the two counts part company.
 */
TEST(Reference, CellEnumerationMatchesSquareEnumeration) {
  Puzzle puzzle = test::board({"..", "..", ".."});
  test::withRunRule(puzzle, kDark, 2);
  test::withShape(puzzle, {{0, 0}, {1, 0}});
  const Model model = buildModel(puzzle);

  std::vector<int> squares;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    squares.push_back(i);
  ASSERT_EQ(squares.size(), 6U);

  std::vector<Colors> bySquare;
  Colors colors{};
  colors.fill(kUnplayable);
  for (unsigned code = 0; code < 1U << 6U; code++) {
    for (std::size_t bit = 0; bit < squares.size(); bit++)
      colors[slot(squares[bit])] = (code >> bit & 1U) != 0 ? kLight : kDark;
    if (verify::check(model, colors) == verify::Violation::None)
      bySquare.push_back(colors);
  }

  const reference::Answer byCell = reference::enumerate(model);
  ASSERT_TRUE(byCell.ranToCompletion);
  EXPECT_EQ(byCell.solutionCount, bySquare.size());
  ASSERT_FALSE(bySquare.empty()) << "the board must admit something to compare";

  // And the same intersection, which is what an underclued answer is made of.
  Colors forced = bySquare.front();
  for (const Colors &one : bySquare) {
    for (const int i : squares) {
      if (forced[slot(i)] != one[slot(i)])
        forced[slot(i)] = kUnknown;
    }
  }
  EXPECT_TRUE(sameOnBoard(model, byCell.forced, forced));
}

} // namespace
