#pragma once

#include <cstdint>
#include <random>

// Deterministic, seed-reproducible randomness for fixture generation and the
// test suite.
//
// Deliberately NOT a cryptographic generator. SonarQube's S2245 suggests
// replacing std::mt19937 with a CSPRNG — libsodium's randombytes_uniform(),
// Botan's randomize(). Those seed themselves from the operating system and
// cannot be seeded deterministically, which is the one property everything
// here depends on:
//
//   * `--generate --seed N` must keep producing the same board, because
//     fuzzShiftingMosaic.ts addresses boards by seed and a failing fuzz board
//     is only debuggable if it can be re-run from that seed.
//   * the C++ tests seed fixed values so a failure reproduces exactly; see
//     testSeed() in test/DragSolverTestOracle.h for the env override.
//
// Nothing drawn here guards a secret — the draws pick puzzle layouts and test
// inputs. Speed is a secondary reason (a ChaCha20-based CSPRNG costs roughly
// an order of magnitude more per draw, which the shuffle loop in
// BenchCommands.cpp would feel), but reproducibility is the decisive one.
//
// Wrapping the engine keeps that argument in ONE place: the suppression below
// covers this single declaration, and every call site stays fully analysed
// rather than carrying a suppression of its own.
class SeededRng {
public:
  explicit SeededRng(const uint32_t seed) : engine_(seed) {}

  // A uniform draw in [lo, hi], for call sites that do not keep a
  // distribution object around.
  int uniform(const int lo, const int hi) {
    return std::uniform_int_distribution(lo, hi)(engine_);
  }

  // For call sites that reuse a distribution across many draws. Equivalent to
  // calling `dist(engine)` directly, so draw sequences are unchanged.
  template <typename Distribution> auto draw(Distribution &dist) {
    return dist(engine_);
  }

private:
  std::mt19937 engine_; // NOSONAR - see the header comment: seedability is required
};
