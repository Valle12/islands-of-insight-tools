#pragma once

#include "Replay.h"

#include <string>

// Fixture JSON <-> Puzzle, native builds only (the CLI and the gtest suite).
// Deliberately NOT part of the wasm source list: it drags in nlohmann_json
// and exceptions, and the bindings build their Puzzle straight from JS
// values.
namespace fixtureio {

// Loads a rollingBlocksTest*.json fixture (the app's own download format).
// Throws std::runtime_error with a readable message on a missing file or a
// malformed document.
replay::Puzzle load(const std::string &path);

} // namespace fixtureio
