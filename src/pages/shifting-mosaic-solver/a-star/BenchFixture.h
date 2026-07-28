#pragma once

#include "SolverClock.h"
#include "Types.h"

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

// Fixture I/O and plan validation for the bench CLI (main.cpp), split out of
// it purely for file size. Nothing here is solver logic — it is the harness
// that feeds boards in and checks what comes back out.

// Thrown by loadFixture for anything wrong with the file: unreadable, not
// JSON, or internally inconsistent. Distinct from the std:: exceptions
// nlohmann::json raises so callers can tell the two apart.
class FixtureError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

struct Fixture {
  uint8_t gridWidth{};
  uint8_t gridHeight{};
  std::vector<std::vector<Position>> shapes;
  std::vector<Position> initialAnchors;
  uint8_t goalIndex{};
  Position goalAnchor{};
};

Fixture loadFixture(const std::string &path);

// Index of the first illegal move, or SIZE_MAX when the whole stream is
// legal; `anchors` is left holding the position reached.
size_t firstIllegalMove(const Fixture &data, const std::vector<Turn> &turns,
                        std::vector<Position> &anchors);

bool replaySolves(const Fixture &data, const std::vector<Turn> &turns);
size_t countPlayerSteps(const std::vector<Turn> &turns);
size_t countDirRuns(const std::vector<Turn> &turns);

bool writeFixtureAt(const Fixture &data, const std::vector<Position> &anchors,
                    const std::string &path);
void writeTurnsFile(const std::vector<Turn> &turns, const std::string &path);
