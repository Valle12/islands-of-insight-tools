#pragma once

#include "Bitboard.h"
#include "Puzzle.h"
#include "Types.h"

#include <cstdint>
#include <vector>

// The mutable half of a search: what each cell may still be, and how to put it
// back.
//
// A cell's domain is two bits held in two board-wide sets — `mayDark_` and
// `mayLight_`. Both only ever LOSE bits as a search descends, which is what
// makes undo a matter of setting a bit again rather than copying a state:
//
//   both bits  -> undecided        one bit -> decided
//   no bits    -> a contradiction  (the cell can be neither colour)
//
// Assigning a colour is therefore the same operation as excluding the other
// one, and the trail records exclusions rather than assignments.
//
// There is deliberately no union-find of the assigned components here. Every
// region question this solver asks is answered by a flood fill over `Bits`,
// which costs a few microseconds and needs no rollback at all; a rollback DSU
// would answer the same questions in O(1) but has to be written without path
// compression and with an undo log per union, and it is only worth that once
// the fills are measurably the bottleneck.
namespace lg {

class Domains {
public:
  /// A point the search can come back to.
  struct Snapshot {
    size_t trail = 0;
    size_t assigned = 0;
    size_t head = 0;
  };

  explicit Domains(const Model &model)
      : playable_(model.playable), mayDark_(model.playable),
        mayLight_(model.playable), playableCount_(model.playableCount) {}

  [[nodiscard]] bool mayBe(const int index, const uint8_t color) const {
    return possible(color).test(index);
  }

  /// The colour a cell is known to hold, kUnknown while it is undecided, and
  /// kUnplayable for a gap.
  [[nodiscard]] uint8_t colorOf(const int index) const {
    if (!playable_.test(index))
      return kUnplayable;
    const bool dark = mayDark_.test(index);
    if (const bool light = mayLight_.test(index); dark == light)
      return kUnknown;
    return dark ? kDark : kLight;
  }

  [[nodiscard]] bool isDecided(const int index) const {
    return playable_.test(index) && mayDark_.test(index) != mayLight_.test(index);
  }

  /// Every cell that may still take `color`, decided or not.
  [[nodiscard]] const Bits &possible(const uint8_t color) const {
    return color == kDark ? mayDark_ : mayLight_;
  }

  /// Every cell known to hold `color`.
  [[nodiscard]] Bits definite(const uint8_t color) const {
    return color == kDark ? mayDark_.without(mayLight_)
                          : mayLight_.without(mayDark_);
  }

  [[nodiscard]] Bits undecided() const { return mayDark_ & mayLight_; }

  [[nodiscard]] int decidedCount() const {
    return static_cast<int>(assigned_.size());
  }

  [[nodiscard]] bool complete() const { return decidedCount() == playableCount_; }

  /**
   * Takes `color` out of a cell's domain. False when that leaves the cell with
   * nothing it can be, which is a contradiction the caller must act on.
   *
   * A cell that becomes decided joins the propagation queue exactly once: the
   * second exclusion on the same cell reports the contradiction before it can
   * enqueue anything.
   */
  bool exclude(const int index, const uint8_t color) {
    Bits &mask = color == kDark ? mayDark_ : mayLight_;
    if (!mask.test(index))
      return true;
    mask.reset(index);
    trail_.push_back({.index = index, .color = color});
    if (!possible(opposite(color)).test(index))
      return false;
    assigned_.push_back(index);
    return true;
  }

  /// Fixes a cell to `color`; the same operation as excluding the other one.
  bool assign(const int index, const uint8_t color) {
    return exclude(index, opposite(color));
  }

  [[nodiscard]] Snapshot snapshot() const {
    return {.trail = trail_.size(),
            .assigned = assigned_.size(),
            .head = head_};
  }

  void restore(const Snapshot &snapshot) {
    while (trail_.size() > snapshot.trail) {
      const auto [index, color] = trail_.back();
      trail_.pop_back();
      Bits &mask = color == kDark ? mayDark_ : mayLight_;
      mask.set(index);
    }
    assigned_.resize(snapshot.assigned);
    head_ = snapshot.head;
  }

  /// Cells decided since the propagator last looked.
  [[nodiscard]] bool hasPending() const { return head_ < assigned_.size(); }
  int nextPending() { return assigned_[head_++]; }
  /// Marks everything decided so far as seen, without propagating it.
  void skipPending() { head_ = assigned_.size(); }

  /// The colouring as it stands, for the oracle and for the answer.
  [[nodiscard]] Colors toColors() const {
    Colors colors{};
    colors.fill(kUnplayable);
    for (int i = playable_.nextSet(0); i >= 0; i = playable_.nextSet(i + 1))
      colors[slot(i)] = colorOf(i);
    return colors;
  }

private:
  struct Removal {
    int index = 0;
    uint8_t color = kDark;
  };

  Bits playable_;
  Bits mayDark_;
  Bits mayLight_;
  int playableCount_ = 0;
  std::vector<Removal> trail_;
  std::vector<int> assigned_;
  size_t head_ = 0;
};

} // namespace lg
