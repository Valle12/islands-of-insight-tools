#pragma once

#include <cstdint>
#include <random>

// Deterministic, seed-reproducible randomness for fixture generation.
// Same design and rationale as the shifting-mosaic solver's SeededRng.
//
// Deliberately NOT a cryptographic generator. SonarQube's S2245 suggests
// replacing std::mt19937 with a CSPRNG; those seed themselves from the
// operating system and cannot be seeded deterministically, which is the one
// property everything here depends on: `--generate --seed N` must keep
// producing the same board, because fuzzMatchThree.ts addresses boards by
// seed and a failing fuzz board is only debuggable if it can be re-run from
// that seed. Nothing drawn here guards a secret — the draws pick puzzle
// layouts.
class SeededRng {
public:
  explicit SeededRng(const uint32_t seed) : engine_(seed) {}

  // A uniform draw in [lo, hi].
  int uniform(const int lo, const int hi) {
    return std::uniform_int_distribution(lo, hi)(engine_);
  }

private:
  std::mt19937 engine_; // NOSONAR - see the header comment: seedability is required
};
