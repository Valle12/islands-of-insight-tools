#pragma once

#include "Replay.h"

#include <stdexcept>
#include <string>

#include <vector>

// Fixture JSON <-> Puzzle, native builds only (the CLI and the gtest suite).
// Deliberately NOT part of the wasm source list: it drags in nlohmann_json
// and exceptions, and the bindings build their Puzzle straight from JS
// values.
namespace fixtureio {

// Thrown when the fixture file itself cannot be read. Distinct from the
// nlohmann::json exceptions a malformed document raises, so a caller can tell
// "no such fixture" from "bad fixture"; still a std::runtime_error, so the
// `catch (const std::exception &)` sites in main.cpp and the gtest suites keep
// reporting it unchanged.
class FixtureError final : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

// Loads a rollingBlocksTest*.json fixture (the app's own download format).
// Throws a std::exception on failure: FixtureError with a readable message for
// a missing file, nlohmann::json::exception for a malformed document. When
// `turnsOut` is given, the fixture's optional recorded solution is parsed into
// it (left empty if absent).
replay::Puzzle load(const std::string &path,
                    std::vector<Turn> *turnsOut = nullptr);

} // namespace fixtureio
