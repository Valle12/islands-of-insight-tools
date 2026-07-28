#pragma once

#include "BenchFixture.h"

#include <cstdint>
#include <string>

// The bench CLI's non-solve subcommands. Each returns a process exit code.

// Replays a turn stream read from a file — the safety net for a plan
// STITCHED from two independently-solved halves.
int runVerify(const Fixture &data, const std::string &turnsPath);

// Builds a random solvable fixture and writes it to outPath.
int runGenerate(const std::string &outPath, uint32_t seed,
                uint32_t shuffleMoves, bool emitJson);

int usage(const char *argv0);
