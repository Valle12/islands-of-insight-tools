#include "Routing.h"

#include "Bitboard.h"
#include "Budget.h"
#include "Puzzle.h"
#include "Types.h"
#include "Verify.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

namespace lg::routing {
namespace {

/**
 * How many times every net is torn up and rerouted before the router restarts
 * with a clean history, and how many such restarts it will take.
 *
 * Measured on the captured 23x21 board: it settles after about twelve restarts
 * and 49 000 rounds, a touch under seven seconds. Cutting the rounds to a few
 * hundred does not settle it at all — the nets need thousands of rounds of
 * rising pressure to be pushed into the winding routes the answer needs — which
 * is why these are this large and not a safety margin over something smaller.
 * The budget stops a runaway long before the product of the two.
 */
constexpr int kMaxRounds = 4000;
constexpr int kMaxRestarts = 40;

/**
 * The congestion price, and why it has to GROW.
 *
 * A flat price oscillates: two nets want one cell, each reroutes off it when
 * the other is on it, and they swap forever. Two things break that. The
 * PRESSURE factor rises every round, so late rounds care about collisions far
 * more than about length and the nets are eventually forced apart. And the
 * HISTORY of a cell — how many rounds it has been fought over — is charged
 * even once it is free, which is what stops the pair simply trading places.
 *
 * Both are the standard negotiated-congestion recipe. The growth rate is the
 * one measured to settle the captured 23x21 board fastest — halving it takes
 * seven seconds to sixteen, doubling it to eight — so the shape of the curve
 * matters and the exact number does not. A FLAT price is the one variant that
 * does not converge at all.
 */
constexpr int kPressureBase = 2;
constexpr int kPressureGrowth = 12;
constexpr int kHistoryStep = 1;

/// A cost no route takes unless there is nothing else, used for the terminals
/// of other nets. Far below overflow with `kMaxCells` cells on a path.
constexpr int kBlocked = 1 << 20;

/// The letters to route, each as the cells that must end up in one region.
struct Net {
  std::vector<int> terminals;
};

/// A tiny deterministic generator. The router only needs to vary the order it
/// visits nets in; anything reproducible does, and pulling in `SeededRng` would
/// tie a wasm translation unit to the generator's header for four lines.
class Shuffler {
public:
  explicit Shuffler(const uint32_t seed) : state_(seed | 1U) {}

  uint32_t next() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }

  void shuffle(std::vector<int> &order) {
    for (size_t i = order.size(); i > 1; i--) {
      const size_t j = next() % i;
      std::swap(order[i - 1], order[j]);
    }
  }

private:
  uint32_t state_;
};

/// The four orthogonal neighbours of `index` that are on the board.
void forEachNeighbour(const Model &model, const int index,
                      const auto &visit) {
  const int x = columnOf(index);
  const int y = rowOf(index);
  if (x > 0)
    visit(cellIndex(x - 1, y));
  if (x + 1 < model.width())
    visit(cellIndex(x + 1, y));
  if (y > 0)
    visit(cellIndex(x, y - 1));
  if (y + 1 < model.height())
    visit(cellIndex(x, y + 1));
}

/// Every cell that may take `color`: playable, and either uncoloured already or
/// given that very colour.
Bits roomFor(const Model &model, const uint8_t color) {
  Bits room;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (const uint8_t given = model.puzzle.givens[slot(i)];
        given == kUnknown || given == color)
      room.set(i);
  }
  return room;
}

/**
 * The state one routing attempt carries: what each net claims, and what every
 * cell has cost it over the rounds so far.
 *
 * `claimed[k]` is the net's own cells; `halo[k]` is those cells GROWN by one,
 * which is what "two nets would merge" really means — regions touching across a
 * seam are one region, so keeping the claims disjoint is not enough.
 */
struct Board {
  std::vector<Bits> claimed;
  std::vector<Bits> halo;
  std::vector<int> history;
};

/**
 * What `cell` costs `self` because of the nets already there.
 *
 * A cell another net CLAIMS is the real collision and is charged in full. A
 * cell merely BESIDE another net's claim is charged half: taking it would make
 * the two regions touch, which is just as fatal — two regions of one colour
 * that meet ARE one region — but it is a weaker signal, since a route usually
 * has somewhere else to go. Charging a halo like an overlap prices most of the
 * board out of reach and measurably stops the router settling.
 */
int pressureAt(const Board &board, const int cell, const int self) {
  int pressure = 0;
  for (size_t k = 0; k < board.claimed.size(); k++) {
    if (static_cast<int>(k) == self)
      continue;
    if (board.claimed[k].test(cell))
      pressure += 2;
    else if (board.halo[k].test(cell))
      pressure += 1;
  }
  return pressure;
}

/**
 * Everything one round of routing holds fixed: the puzzle, the board being
 * built, the cells any net of this colour may use, the nets themselves and
 * their terminals, and how dearly this round charges for a cell another net
 * wants.
 *
 * `board` is not const because `routeNet` writes each net's claim back into it;
 * everything below `routeNet` only ever reads it. Bundled because the price
 * curve is per-round and the rest never changes at all, which is what kept
 * `shortestPath` at eight parameters.
 */
struct Round {
  const Model &model;
  Board &board;
  const Bits &room;
  const std::vector<Net> &nets;
  const Bits &allTerminals;
  int pressureCost = 0;
};

/**
 * Dijkstra from everything in `from` to the nearest cell of `to`, through
 * `room`, returning the path found or an empty vector.
 *
 * Multi-source so a net with three terminals grows a TREE: the second terminal
 * is routed to the first, and the third to everything already claimed rather
 * than to one chosen end.
 */
std::vector<int> shortestPath(const Round &round, const int self,
                              const Bits &from, const Bits &to,
                              const Bits &otherTerminals) {
  constexpr int kUnreached = INT32_MAX;
  std::vector<int> dist(kMaxCells, kUnreached);
  std::vector<int> prev(kMaxCells, -1);
  // A bucket queue would be tighter, but the cells are few and the costs are
  // small integers; a sorted scan of the open set is simpler to read and never
  // showed up beside the flood fills.
  std::vector<int> open;
  for (int i = from.nextSet(0); i >= 0; i = from.nextSet(i + 1)) {
    dist[slot(i)] = 0;
    open.push_back(i);
  }

  int reached = -1;
  while (!open.empty()) {
    const auto best = std::ranges::min_element(
        open, [&dist](const int left, const int right) {
          return dist[slot(left)] < dist[slot(right)];
        });
    const int cell = *best;
    open.erase(best);
    if (to.test(cell)) {
      reached = cell;
      break;
    }
    forEachNeighbour(round.model, cell,
                     [&round, &otherTerminals, &dist, &prev, &open, self,
                      cell](const int next) {
      if (!round.room.test(next))
        return;
      // Multiplicative, so history and congestion compound rather than merely
      // adding: a cell that is both contested and historically expensive is
      // what the nets must be pushed off first.
      //
      // Deliberately NO random jitter. It is tempting as a tie-break, but a
      // weight redrawn on every relaxation is not a weight at all — Dijkstra
      // needs the cost of a cell to be the same however it is reached, and
      // noise of the same size as the base step swamps the very differences
      // the price exists to express. Variation between rounds comes from the
      // order the nets are rerouted in, which is shuffled.
      const int step =
          otherTerminals.test(next)
              ? kBlocked
              : (1 + round.board.history[slot(next)] * kHistoryStep) *
                    (1 + pressureAt(round.board, next, self) *
                             round.pressureCost);
      if (const int through = dist[slot(cell)] + step;
          through < dist[slot(next)]) {
        dist[slot(next)] = through;
        prev[slot(next)] = cell;
        open.push_back(next);
      }
    });
  }

  std::vector<int> path;
  if (reached < 0)
    return path;
  for (int cell = reached; cell >= 0; cell = prev[slot(cell)])
    path.push_back(cell);
  return path;
}

/// Rebuilds one net's claim from scratch: its terminals, joined one at a time
/// through the cheapest cells left.
bool routeNet(const Round &round, const int self) {
  const Net &net = round.nets[slot(self)];
  Bits mine;
  mine.set(net.terminals.front());
  Bits otherTerminals = round.allTerminals;
  for (const int cell : net.terminals)
    otherTerminals.reset(cell);

  for (size_t i = 1; i < net.terminals.size(); i++) {
    Bits target;
    target.set(net.terminals[i]);
    if (mine.test(net.terminals[i]))
      continue;
    const std::vector<int> path =
        shortestPath(round, self, mine, target, otherTerminals);
    if (path.empty())
      return false;
    for (const int cell : path)
      mine.set(cell);
  }

  round.board.claimed[slot(self)] = mine;
  round.board.halo[slot(self)] = mine | mine.grown();
  return true;
}

/// One round: every net torn up and rerouted in `order`. False when a net has
/// nowhere to go at all, which means this colour cannot work on this board
/// whatever the congestion — there is no point rerouting.
bool routeRound(const Round &round, const std::vector<int> &order) {
  return std::ranges::all_of(
      order, [&round](const int self) { return routeNet(round, self); });
}

/// The colouring a finished routing describes: every claimed cell takes the
/// nets' colour, every given keeps itself, and everything else takes the other
/// colour.
Colors paint(const Model &model, const Board &board, const uint8_t color) {
  Colors colors{};
  colors.fill(kUnplayable);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (const uint8_t given = model.puzzle.givens[slot(i)];
        given != kUnknown) {
      colors[slot(i)] = given;
      continue;
    }
    const bool held = std::ranges::any_of(
        board.claimed, [i](const Bits &net) { return net.test(i); });
    colors[slot(i)] = held ? color : opposite(color);
  }
  return colors;
}

/// Whether every net is alone: no two claims overlap or touch, which is what
/// stops two letters sharing a region.
bool separated(const Board &board) {
  for (size_t k = 0; k < board.claimed.size(); k++) {
    for (size_t other = k + 1; other < board.claimed.size(); other++) {
      if ((board.claimed[k] & board.halo[other]).any())
        return false;
    }
  }
  return true;
}

/// Every terminal of every net, or false when one of them is off `room` — a
/// letter the puzzle already paints the other colour, which no routing fixes.
bool gatherTerminals(const std::vector<Net> &nets, const Bits &room,
                     Bits &allTerminals) {
  for (const Net &net : nets) {
    for (const int cell : net.terminals) {
      if (!room.test(cell))
        return false;
      allTerminals.set(cell);
    }
  }
  return true;
}

/// Charges every contested cell, so the nets that keep colliding are pushed
/// apart rather than swapping the same cell round after round.
void chargeContested(Board &board) {
  for (size_t k = 0; k < board.claimed.size(); k++) {
    const Bits &mine = board.claimed[k];
    for (int i = mine.nextSet(0); i >= 0; i = mine.nextSet(i + 1)) {
      if (pressureAt(board, i, static_cast<int>(k)) > 0)
        board.history[slot(i)] += kHistoryStep;
    }
  }
}

/// One colour's worth of routing: every net light, or every net dark.
bool routeAll(const Model &model, const std::vector<Net> &nets,
              const uint8_t color, Budget &budget, Colors &answer) {
  const Bits room = roomFor(model, color);
  Bits allTerminals;
  if (!gatherTerminals(nets, room, allTerminals))
    return false;

  std::vector<int> order(nets.size());
  for (size_t i = 0; i < order.size(); i++)
    order[i] = static_cast<int>(i);

  for (int restart = 0; restart < kMaxRestarts; restart++) {
    // A fresh history each restart. A run that has not settled by now is
    // usually stuck behind history it charged early and cannot unlearn, and
    // starting over with a different visiting order costs one round.
    Board board{.claimed = std::vector<Bits>(nets.size()),
                .halo = std::vector<Bits>(nets.size()),
                .history = std::vector<int>(kMaxCells, 0)};
    Shuffler shuffler(0x9E3779B9U ^ (static_cast<uint32_t>(color) << 16U) ^
                      static_cast<uint32_t>(restart + 1));

    for (int round = 0; round < kMaxRounds; round++) {
      if (budget.exhausted())
        return false;
      shuffler.shuffle(order);
      if (!routeRound({.model = model,
                       .board = board,
                       .room = room,
                       .nets = nets,
                       .allTerminals = allTerminals,
                       .pressureCost = kPressureBase + round / kPressureGrowth},
                      order))
        return false;
      if (separated(board)) {
        answer = paint(model, board, color);
        // The construction is a heuristic and this is the only thing standing
        // between a misread puzzle and a wrong answer, so it is never skipped.
        return verify::check(model, answer) == verify::Violation::None;
      }
      chargeContested(board);
    }
  }
  return false;
}

} // namespace

bool applicable(const Model &model) {
  if (model.hasShapes)
    return false;
  if (model.puzzle.ruleMask != 0 || !model.puzzle.areas.empty() ||
      !model.puzzle.runs.empty())
    return false;
  if (std::ranges::any_of(model.puzzle.clues, [](const Clue &clue) {
        return clue.kind != kClueLetter;
      }))
    return false;
  return model.letters.size() >= 2;
}

Outcome runRouting(const Model &model, const Config &cfg) {
  Outcome outcome;
  if (!applicable(model))
    return outcome;

  Budget budget(cfg, "routing", outcome.stats);
  std::vector<Net> nets;
  nets.reserve(model.letters.size());
  for (const LetterGroup &group : model.letters)
    nets.push_back({.terminals = group.cells});

  // Both colours, because which one the letters take is the puzzle's to say:
  // the captured lattice wants them light, and its own complement wants them
  // dark. Light first only because a board of givens is usually mostly dark.
  for (const uint8_t color : {kLight, kDark}) {
    if (Colors answer{}; routeAll(model, nets, color, budget, answer)) {
      outcome.status = Status::Solved;
      outcome.colors = answer;
      outcome.decided = model.playable.count();
      outcome.witnesses.push_back(answer);
      return outcome;
    }
  }
  return outcome;
}

} // namespace lg::routing
