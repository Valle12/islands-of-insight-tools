#pragma once

#include <cstdint>
#include <string>

// Fixture generation for the fuzz campaign (native CLI only — writes JSON
// with nlohmann, never part of the wasm source lists). Every generated board
// is solvable by construction and ships its witness in the fixture's `turns`;
// the generator replay-validates the witness before writing and fails loudly
// if construction ever breaks.
namespace generate {

// kind: "goal" (place blocks on goal footprints, scramble with random rolls),
// "coverage" (self-avoiding walk marking first-touched cells as must-touch),
// or "mixed" (both, in disjoint board regions split by an unplayable
// divider). Returns the process exit code; prints a summary JSON as the last
// stdout line.
int run(const std::string &outPath, uint32_t seed, uint32_t shuffle,
        const std::string &kind);

} // namespace generate
