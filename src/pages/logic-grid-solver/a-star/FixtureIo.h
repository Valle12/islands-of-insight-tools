#pragma once

#include "Puzzle.h"

#include <stdexcept>
#include <string>

// The page's own download format, read and written.
//
// Native only: nlohmann and exceptions are both absent from the wasm build, so
// this must never join the `sources` list in src/util/buildWasm.ts. The wasm
// side receives an already-parsed puzzle across the embind boundary instead.
namespace lg::fixtureio {

/// A file that could not be read as a puzzle. Distinct from
/// `nlohmann::json::exception`, which means the document itself is malformed:
/// callers treat the first as an environment problem and the second as a
/// broken fixture.
class FixtureError final : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

/**
 * Which shape of the download format this build reads and writes — the same
 * number `CONFIG_VERSION` holds in `src/pages/logic-grid-solver/config.ts`,
 * and the two have to move together.
 *
 * A file with no `version` key is version 1, the format as it stood before the
 * tag existed, which is what lets every fixture captured before it load
 * unchanged.
 *
 * There are deliberately NO migrations here. The page migrates, because it is
 * the only side that reads files a stranger wrote; these tools read this
 * repo's own fixtures, which are rewritten to the new shape in the same change
 * that raises the version. An older file reaching them means that rewrite was
 * missed, so it is refused rather than guessed at.
 */
inline constexpr int kConfigVersion = 1;

struct Fixture {
  Puzzle puzzle;
  /**
   * The colouring `--generate` derived the clues from, when the file carries
   * one under an optional `solution` key.
   *
   * The page's validator drops keys it does not know, so a generated fixture
   * still loads straight into the editor — the same arrangement rolling-blocks
   * uses for its `turns`. It is a witness, not an expected answer: these
   * puzzles are solvable by construction but rarely unique.
   */
  bool hasSolution = false;
  Colors solution{};
};

Fixture load(const std::string &path);
void save(const std::string &path, const Fixture &fixture);

} // namespace lg::fixtureio
