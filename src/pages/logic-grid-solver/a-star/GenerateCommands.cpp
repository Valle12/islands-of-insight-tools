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

/// The rules that constrain a colouring. `Underclued` is not one of them: it
/// changes what the answer is, never which colourings are legal.
constexpr auto kColorRules = std::to_array<Rule>(
    {Rule::NoDark2x2, Rule::NoLight2x2, Rule::ConnectDark, Rule::ConnectLight,
     Rule::NoLight1x2, Rule::NoDark1x2, Rule::NoLight1x3, Rule::NoDark1x3,
     Rule::NoLight1x4, Rule::NoDark1x4, Rule::NoCheckerboard, Rule::NoLight1x5,
     Rule::NoDark1x5, Rule::OneSymbolDark, Rule::OneSymbolLight});

int piecesBeyondOne(const Model &model, const Colors &colors,
                    const uint8_t color, const Rule rule) {
  if (!model.hasRule(rule))
    return 0;
  Bits held;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (colors[slot(i)] == color)
      held.set(i);
  }
  const int seed = held.nextSet(0);
  if (seed < 0)
    return 0;
  return held.without(component(seed, held)).count();
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
  int bad = 0;
  for (const Clause &clause : model.clauses)
    bad += clauseHolds(clause, colors) ? 1 : 0;
  bad += piecesBeyondOne(model, colors, kDark, Rule::ConnectDark);
  bad += piecesBeyondOne(model, colors, kLight, Rule::ConnectLight);
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
};

/// The state that crosses every region: where the clues go, which cells already
/// carry one, and the next unused letter.
struct ClueRun {
  SeededRng &rng;
  Puzzle &puzzle;
  Bits &used;
  int letter = 0;
};

/**
 * Puts at most one clue on one region, reading its value off the colouring.
 *
 * The THREE `rng` draws here are in a fixed order — the spot, the area roll,
 * then the letter roll — and the last one is behind a short circuit that skips
 * it entirely once every letter is spent. Reordering them, or hoisting one out
 * of its condition, silently changes every board this generator has ever
 * produced. Hash-compare regenerated fixtures across several seeds after
 * touching this.
 */
void clueOneRegion(ClueRun &run, const ClueChances &chances,
                   const std::vector<int> &cells, const int size) {
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
  }
}

/// Reads clues off the colouring the board was given, so every one of them is
/// satisfiable together by construction.
void deriveClues(const Model &model, const Colors &colors, SeededRng &rng,
                 const bool sparse, Puzzle &puzzle) {
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
                            .letter = sparse ? 10 : 25};

  for (const Bits &side : {colored, light}) {
    const Regions regions = labelRegions(side, model);
    for (int id = 0; id < regions.count(); id++) {
      if (const std::vector<int> cells = freeCellsOf(side, regions, used, id);
          !cells.empty())
        clueOneRegion(run, chances, cells, regions.size[slot(id)]);
    }
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

    deriveClues(bare, colors, rng, sparse, puzzle);
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
