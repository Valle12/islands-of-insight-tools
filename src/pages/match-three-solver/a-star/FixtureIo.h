#pragma once

#include "Types.h"

#include <stdexcept>
#include <string>

// Fixture JSON <-> Board, native builds only (the CLI and the gtest suite).
// Deliberately NOT part of the wasm source list: it drags in nlohmann_json and
// exceptions, and the bindings build their Board straight from JS values.
namespace mt::fixtureio {

// Thrown when the fixture file itself cannot be read. Distinct from the
// nlohmann::json exceptions a malformed document raises, so a caller can tell
// "no such fixture" from "bad fixture"; still a std::runtime_error, so the
// `catch (const std::exception &)` sites keep reporting it unchanged.
class FixtureError final : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

/// Loads a matchThreeTest*.json fixture — the app's own download format, whose
/// `cells` is column-major (`cells[x][y]`) where a Board is row-major.
Board load(const std::string &path);

/// Writes a board back out in that same format, so a generated board is
/// directly loadable by the page.
void save(const std::string &path, const Board &board);

} // namespace mt::fixtureio
