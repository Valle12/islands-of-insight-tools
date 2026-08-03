#include "GenerateCommands.h"

#include "Bitboard.h"
#include "FixtureIo.h"
#include "Puzzle.h"
#include "Regions.h"
#include "Rules.h"
#include "SeededRng.h"
#include "Types.h"
#include "Verify.h"

#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace lg::generate {
namespace {

using rules::Rule;

inline constexpr int kRestarts = 40;
inline constexpr int kStepsPerRestart = 20000;
/// How often a step ignores the score and flips something anyway, which is
/// what gets a local search off a plateau.
inline constexpr int kNoisePercent = 8;

/// Keeps the merged-cell draws off the main stream. Any constant does; what
/// matters is that `--shapes 0` touches the main rng not at all, so every seed
/// still regenerates the board it always did.
inline constexpr uint32_t kShapeSalt = 0x5EA'11EDU;

/// The rules that constrain a colouring. `Underclued` is not one of them: it
/// changes what the answer is, never which colourings are legal.
///
/// The ORDER is load-bearing in a way the list itself is not: `emptyBoard` draws
/// once per entry from the same rng that then feeds the local search, so
/// appending here shifts every board this generator produces for a given seed.
/// Nothing on disk depends on that — the captured fixtures are captures — but a
/// fuzz baseline has to be retaken.
constexpr auto kColorRules = std::to_array<Rule>(
    {Rule::NoDark2x2, Rule::NoLight2x2, Rule::ConnectDark, Rule::ConnectLight,
     Rule::NoLight1x2, Rule::NoDark1x2, Rule::NoLight1x3, Rule::NoDark1x3,
     Rule::NoLight1x4, Rule::NoDark1x4, Rule::NoCheckerboard, Rule::NoLight1x5,
     Rule::NoDark1x5, Rule::OneSymbolDark, Rule::OneSymbolLight,
     Rule::AreaTwoDark, Rule::AreaTwoLight, Rule::AreaFourDark,
     Rule::AreaFourLight});

Bits heldBy(const Model &model, const Colors &colors, const uint8_t color) {
  Bits held;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == color)
      held.set(i);
  }
  return held;
}

int piecesBeyondOne(const Model &model, const Colors &colors,
                    const uint8_t color, const Rule rule) {
  if (!model.hasRule(rule))
    return 0;
  const Bits held = heldBy(model, colors, color);
  const int seed = held.nextSet(0);
  if (seed < 0)
    return 0;
  return held.without(component(seed, held)).count();
}

/**
 * How far every region of `color` is from the size its rule demands.
 *
 * For an area of TWO the clause table already scores a region that is too BIG,
 * since every one of those contains a forbidden tromino, and all this has to
 * add is the too-small half — without which the local search reaches `cost == 0`
 * with singletons still standing, `verify::check` throws the result out, and
 * every attempt fails. For area FOUR there are no clauses at all, so this is
 * the whole gradient and it has to score both halves.
 *
 * Counted as the distance from the target rather than as a flag per region, so
 * a region three cells short scores worse than one that is one cell short and
 * the search has something to walk down.
 */
int regionsOffSize(const Model &model, const Colors &colors) {
  int bad = 0;
  for (const auto &[rule, color, area] : rules::kAreaFamily) {
    if (!model.hasRule(rule))
      continue;
    const Bits held = heldBy(model, colors, color);
    Bits seen;
    for (int i = held.nextSet(0); i >= 0; i = held.nextSet(i + 1)) {
      if (seen.test(i))
        continue;
      const Bits region = component(i, held);
      seen = seen | region;
      bad += std::abs(region.count() - area);
    }
  }
  return bad;
}

bool clauseHolds(const Clause &clause, const Colors &colors) {
  for (int i = 0; i < clause.count; i++) {
    if (colors[slot(clause.cells[slot(i)])] != clause.colors[slot(i)])
      return false;
  }
  return true;
}

/// How far this colouring is from legal. Zero means it is a solution of the
/// clue-free board, which is what the generator is looking for.
int cost(const Model &model, const Colors &colors) {
  using enum Rule;
  int bad = 0;
  for (const Clause &clause : model.clauses)
    bad += clauseHolds(clause, colors) ? 1 : 0;
  bad += piecesBeyondOne(model, colors, kDark, ConnectDark);
  bad += piecesBeyondOne(model, colors, kLight, ConnectLight);
  bad += regionsOffSize(model, colors);
  return bad;
}

void randomise(const Model &model, SeededRng &rng, Colors &colors) {
  colors.fill(kUnplayable);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    colors[slot(i)] = rng.uniform(0, 1) == 0 ? kDark : kLight;
}

/// Flips whichever cell of a broken arrangement leaves the board least broken.
void repairClause(const Model &model, const Clause &clause, SeededRng &rng,
                  Colors &colors) {
  int bestCell = clause.cells[0];
  int bestCost = -1;
  for (int i = 0; i < clause.count; i++) {
    const int cell = clause.cells[slot(i)];
    const uint8_t was = colors[slot(cell)];
    colors[slot(cell)] = opposite(was);
    const int after = cost(model, colors);
    colors[slot(cell)] = was;
    if (bestCost < 0 || after < bestCost) {
      bestCost = after;
      bestCell = cell;
    }
  }
  if (rng.uniform(0, 99) < kNoisePercent)
    bestCell = clause.cells[slot(rng.uniform(0, clause.count - 1))];
  colors[slot(bestCell)] = opposite(colors[slot(bestCell)]);
}

/// With no broken arrangement left, only connectivity can be wrong; nudging a
/// random cell is enough to keep the walk moving.
void nudge(const Model &model, SeededRng &rng, Colors &colors) {
  const int count = model.playableCount;
  if (count == 0)
    return;
  int wanted = rng.uniform(0, count - 1);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (wanted == 0) {
      colors[slot(i)] = opposite(colors[slot(i)]);
      return;
    }
    wanted--;
  }
}

bool walk(const Model &model, SeededRng &rng, Colors &colors) {
  for (int step = 0; step < kStepsPerRestart; step++) {
    if (cost(model, colors) == 0)
      return true;
    std::vector<int> broken;
    int id = 0;
    for (const Clause &clause : model.clauses) {
      if (clauseHolds(clause, colors))
        broken.push_back(id);
      id++;
    }
    if (broken.empty()) {
      nudge(model, rng, colors);
      continue;
    }
    const int chosen = broken[slot(rng.uniform(0, static_cast<int>(broken.size()) - 1))];
    repairClause(model, model.clauses[slot(chosen)], rng, colors);
  }
  return cost(model, colors) == 0;
}

bool paintLegal(const Model &model, SeededRng &rng, Colors &colors) {
  for (int restart = 0; restart < kRestarts; restart++) {
    randomise(model, rng, colors);
    if (walk(model, rng, colors))
      return true;
  }
  return false;
}

Puzzle emptyBoard(SeededRng &rng, const Options &options) {
  Puzzle puzzle;
  puzzle.width = options.width > 0 ? options.width : rng.uniform(4, 8);
  puzzle.height = options.height > 0 ? options.height : rng.uniform(4, 8);
  puzzle.givens.fill(kUnplayable);
  for (int y = 0; y < puzzle.height; y++) {
    for (int x = 0; x < puzzle.width; x++) {
      const bool gap = rng.uniform(0, 99) < 8;
      puzzle.givens[slot(cellIndex(x, y))] = gap ? kUnplayable : kUnknown;
    }
  }
  if (options.rules >= 0) {
    puzzle.ruleMask = static_cast<rules::RuleMask>(options.rules);
    return puzzle;
  }
  for (const Rule rule : kColorRules) {
    if (rng.uniform(0, 3) == 0)
      puzzle.ruleMask |= rules::bit(rule);
  }
  return puzzle;
}

/// Every cell of one labelled region that does not already carry a clue.
std::vector<int> freeCellsOf(const Bits &side, const Regions &regions,
                             const Bits &used, const int id) {
  std::vector<int> cells;
  for (int i = side.nextSet(0); i >= 0; i = side.nextSet(i + 1)) {
    if (regions.id[slot(i)] == id && !used.test(i))
      cells.push_back(i);
  }
  return cells;
}

/// How often each kind of clue lands. An underclued board gets far fewer, which
/// is the whole of what makes it underclued.
struct ClueChances {
  int area = 0;
  int letter = 0;
  /// Off unless `--darts` asks for them, so a campaign without it draws no
  /// random number for a dart and reproduces every board it always did.
  int dart = 0;
};

/// The state that crosses every region: where the clues go, which cells already
/// carry one, and the next unused letter.
struct ClueRun {
  SeededRng &rng;
  Puzzle &puzzle;
  Bits &used;
  int letter = 0;
};

/// How many squares of the other colour a dart at `spot` aimed `direction`
/// really sees, read off the colouring so the clue is satisfiable by
/// construction. The same walk `Verify` does, and for the same reason: gaps are
/// stepped over, and the dart's own cell can never be the colour it counts.
int dartValueAt(const Model &model, const Colors &colors, const int spot,
                const int direction) {
  const auto [stepX, stepY] = kDirectionSteps[slot(direction)];
  const uint8_t other = opposite(colors[slot(spot)]);
  int count = 0;
  for (int x = columnOf(spot) + stepX, y = rowOf(spot) + stepY;
       x >= 0 && x < model.width() && y >= 0 && y < model.height();
       x += stepX, y += stepY) {
    if (colors[slot(cellIndex(x, y))] == other)
      count++;
  }
  return count;
}

/**
 * Puts at most one clue on one region, reading its value off the colouring.
 *
 * The `rng` draws here are in a fixed order — the spot, the area roll, the
 * letter roll, then the dart roll — and every one after the first is behind a
 * short circuit that skips it entirely when it cannot apply. Reordering them,
 * or hoisting one out of its condition, silently changes every board this
 * generator has ever produced; the dart pair is appended LAST and skipped
 * outright at `chances.dart == 0`, which is what keeps `--darts 0` reproducing
 * exactly the boards it always did. Hash-compare regenerated fixtures across
 * several seeds after touching this.
 */
void clueOneRegion(ClueRun &run, const ClueChances &chances,
                   const std::vector<int> &cells, const int size,
                   const Model &model, const Colors &colors) {
  const int spot =
      cells[slot(run.rng.uniform(0, static_cast<int>(cells.size()) - 1))];
  if (run.rng.uniform(0, 99) < chances.area) {
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueArea, .value = size});
    return;
  }
  if (run.letter < kLetterCount && run.rng.uniform(0, 99) < chances.letter) {
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot, .kind = kClueLetter, .value = run.letter});
    run.letter++;
    return;
  }
  if (chances.dart > 0 && run.rng.uniform(0, 99) < chances.dart) {
    const int direction = run.rng.uniform(0, kDirectionCount - 1);
    run.used.set(spot);
    run.puzzle.clues.push_back(
        {.index = spot,
         .kind = kClueDart,
         .value = dartValueAt(model, colors, spot, direction),
         .direction = direction});
  }
}

/// Reads clues off the colouring the board was given, so every one of them is
/// satisfiable together by construction.
void deriveClues(const Model &model, const Colors &colors, SeededRng &rng,
                 const bool sparse, const int dartChance, Puzzle &puzzle) {
  Bits colored;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == kDark)
      colored.set(i);
  }
  const Bits light = model.playable.without(colored);

  Bits used;
  ClueRun run{.rng = rng, .puzzle = puzzle, .used = used};
  const ClueChances chances{.area = sparse ? 25 : 70,
                            .letter = sparse ? 10 : 25,
                            .dart = dartChance};

  for (const Bits &side : {colored, light}) {
    const Regions regions = labelRegions(side, model);
    for (int id = 0; id < regions.count(); id++) {
      if (const std::vector<int> cells = freeCellsOf(side, regions, used, id);
          !cells.empty())
        clueOneRegion(run, chances, cells, regions.size[slot(id)], model,
                      colors);
    }
  }
}

/// The squares a shape may grow into: on its border, unclaimed, unclued, and
/// already carrying the colour the shape holds. Draws nothing — the caller
/// picks from what this returns, which is what keeps the rng stream in
/// `fuseCells` independent of how the candidates are gathered.
std::vector<int> growthOptions(const Model &model, const Colors &colors,
                               const Bits &claimed, const Bits &clued,
                               const std::vector<int> &shape,
                               const uint8_t color) {
  Bits mask;
  for (const int square : shape)
    mask.set(square);
  const Bits room = (mask.border() & model.playable).without(claimed);
  std::vector<int> options;
  for (int i = room.nextSet(0); i >= 0; i = room.nextSet(i + 1)) {
    if (colors[slot(i)] == color && !clued.test(i))
      options.push_back(i);
  }
  return options;
}

/**
 * Fuses same-coloured neighbours into merged cells, AFTER the clues have been
 * read off the colouring.
 *
 * Doing it last is what makes it safe rather than merely convenient. The local
 * search never sees a merged cell, so `cost`, `repairClause` and `walk` are
 * untouched; and fusing a connected set that already holds ONE colour cannot
 * invalidate the solution, because the colouring, every region and every area
 * count come out exactly as they were. All that changes is which squares have
 * to move together — so the board this writes is still solvable by construction
 * and the `solution` key still verifies.
 *
 * Two things it must respect: a merged cell carries at most one clue, and it is
 * one connected polyomino. Growing only into unclued, same-coloured, not-yet-
 * claimed neighbours gives both.
 */
void fuseCells(const Model &model, const Colors &colors, SeededRng &rng,
               const int percent, Puzzle &puzzle) {
  Bits clued;
  for (const Clue &clue : puzzle.clues)
    clued.set(clue.index);

  const int budget = model.playableCount * percent / 100;
  Bits claimed;
  int fused = 0;
  for (int seed = model.playable.nextSet(0); seed >= 0 && fused < budget;
       seed = model.playable.nextSet(seed + 1)) {
    if (claimed.test(seed) || rng.uniform(0, 99) >= percent)
      continue;

    std::vector shape{seed};
    claimed.set(seed);
    // Grown one square at a time from the cell's own border, so what comes out
    // is connected however far it runs.
    const int want = rng.uniform(2, 4);
    while (static_cast<int>(shape.size()) < want) {
      const std::vector<int> options = growthOptions(
          model, colors, claimed, clued, shape, colors[slot(seed)]);
      if (options.empty())
        break;
      const int next =
          options[slot(rng.uniform(0, static_cast<int>(options.size()) - 1))];
      claimed.set(next);
      shape.push_back(next);
    }

    if (shape.size() < 2) {
      continue;
    }
    fused += static_cast<int>(shape.size());
    puzzle.shapes.push_back(std::move(shape));
  }
}

} // namespace

int run(const Options &options) {
  SeededRng rng(options.seed);
  const bool sparse = options.kind == "underclued";

  for (int attempt = 0; attempt < 8; attempt++) {
    Puzzle puzzle = emptyBoard(rng, options);
    const Model bare = buildModel(puzzle);
    Colors colors{};
    if (!paintLegal(bare, rng, colors))
      continue;

    deriveClues(bare, colors, rng, sparse, options.darts, puzzle);
    // Off its own stream, and only when asked, so every seed that produced a
    // board before this existed still produces exactly that board.
    if (options.shapes > 0) {
      SeededRng shapeRng(options.seed ^ kShapeSalt);
      fuseCells(bare, colors, shapeRng, options.shapes, puzzle);
    }
    if (sparse)
      puzzle.ruleMask |= rules::bit(Rule::Underclued);
    if (structureProblem(puzzle) != Problem::None)
      continue;

    if (const Model model = buildModel(puzzle);
        verify::check(model, colors) != verify::Violation::None)
      continue;

    const fixtureio::Fixture fixture{
        .puzzle = puzzle, .hasSolution = true, .solution = colors};
    fixtureio::save(options.out, fixture);
    std::cout << "Wrote " << options.out << " (" << puzzle.width << "x"
              << puzzle.height << ", " << puzzle.clues.size() << " clues)\n";
    return 0;
  }

  std::cerr << "Could not build a solvable board for seed " << options.seed
            << "\n";
  return 1;
}

} // namespace lg::generate
