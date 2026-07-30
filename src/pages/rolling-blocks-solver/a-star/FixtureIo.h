#pragma once

#include "Replay.h"

#include <string>

#include <vector>

// Fixture JSON <-> Puzzle, native builds only (the CLI and the gtest suite).
// Deliberately NOT part of the wasm source list: it drags in nlohmann_json
// and exceptions, and the bindings build their Puzzle straight from JS
// values.
namespace fixtureio {

// Loads a rollingBlocksTest*.json fixture (the app's own download format).
// Throws a std::exception on failure: std::runtime_error with a readable
// message for a missing file, nlohmann::json::exception for a malformed
// document. When `turnsOut` is given, the fixture's optional recorded
// solution is parsed into it (left empty if absent).
replay::Puzzle load(const std::string &path,
                    std::vector<Turn> *turnsOut = nullptr);

} // namespace fixtureio
