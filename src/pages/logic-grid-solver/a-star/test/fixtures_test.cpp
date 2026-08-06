#include "TestBoards.h"

#include "FixtureIo.h"
#include "Puzzle.h"
#include "Search.h"
#include "SolverArms.h"
#include "Verify.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

// The captured corpus. Boards are discovered by listing the directory, so
// dropping a fixture in makes it run with no code change here.
namespace {

using namespace lg;

/**
 * Enough for every board that comes out at all, and not much more.
 *
 * The slowest captured board that answers needs about eight seconds
 * (`logicGridTest47`, four letter pairs on an 8x8 with no rules, so the search
 * has to guess most of it); everything else is milliseconds. The one board that
 * never answers would otherwise sit here burning whatever it is given.
 */
constexpr uint32_t kBudgetMs = 90000;

std::vector<std::string> allTestFiles() {
  std::vector<std::string> files;
  const std::filesystem::path dir{TEST_RESOURCES_DIR};
  if (!std::filesystem::is_directory(dir))
    return files;
  for (const auto &entry : std::filesystem::directory_iterator(dir)) {
    if (entry.path().extension() == ".json")
      files.push_back(entry.path().filename().string());
  }
  std::ranges::sort(files);
  return files;
}

/**
 * The corpus holds boards captured from the game and nothing else — anything
 * the tests invent lives in `reference_test.cpp` and `test/logic-grid-solver/
 * boards.ts`, so a made-up board cannot quietly pad this sweep.
 */
TEST(LogicGridCorpus, TheCorpusIsThere) {
  EXPECT_FALSE(allTestFiles().empty());
}

nlohmann::json readJson(const std::string &path) {
  std::ifstream input(path);
  return nlohmann::json::parse(input);
}

/**
 * Every fixture is in the version this build reads, checked HERE rather than
 * left to `load`.
 *
 * `load` throws `FixtureError` for an unreadable file and the sweep below
 * turns that into a `GTEST_SKIP` — right for a missing corpus, and exactly
 * wrong for a stale one, which would go quietly green while testing nothing.
 * A version this build cannot read means the fixtures were not rewritten
 * alongside the bump that raised it, and the whole point of the tag is that
 * such a thing is noticed.
 */
TEST(LogicGridCorpus, EveryBoardIsTheCurrentFormatVersion) {
  for (const std::string &name : allTestFiles()) {
    const nlohmann::json document =
        readJson(std::string(TEST_RESOURCES_DIR) + "/" + name);
    // Absent means the first version — every board captured before the tag
    // existed relies on that, so it is a legal answer and not a hole.
    const int version = document.contains("version")
                            ? document.at("version").get<int>()
                            : 1;
    EXPECT_EQ(version, fixtureio::kConfigVersion) << name;
  }
}

/**
 * A scratch path for the test currently running, in the test binary's own
 * working directory.
 *
 * NOT the system temp directory, which is world-writable — a fixed name there
 * is something any other user on the machine can plant a symlink at before the
 * test opens it. The build directory belongs to the build. And the name
 * carries the TEST's, because `gtest_discover_tests` gives every one of these
 * its own ctest entry: at `-j 4` two of them run as separate processes at the
 * same time and a shared filename would have them deleting each other's file.
 */
std::string scratchPath() {
  const auto *info = testing::UnitTest::GetInstance()->current_test_info();
  const std::string name = info == nullptr ? "scratch" : info->name();
  return (std::filesystem::current_path() / ("lgVersion-" + name + ".json"))
      .string();
}

/** A fixture file holding `document`, removed when the test ends. */
class TempFixture {
public:
  explicit TempFixture(const nlohmann::json &document) {
    std::ofstream output(path_);
    output << document.dump(2);
  }
  TempFixture(const TempFixture &) = delete;
  TempFixture &operator=(const TempFixture &) = delete;
  TempFixture(TempFixture &&) = delete;
  TempFixture &operator=(TempFixture &&) = delete;
  /**
   * The `error_code` overload, which is `noexcept`. The throwing one would let
   * a destructor propagate during stack unwinding, and that is a call to
   * `std::terminate` rather than a failing test — so a file that could not be
   * removed is ignored on purpose.
   */
  ~TempFixture() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }

  [[nodiscard]] const std::string &path() const { return path_; }

private:
  // In-class rather than in the constructor's initializer list: there is one
  // constructor and it always wants this value.
  std::string path_ = scratchPath();
};

/** The smallest legal board, as a document to bend one key of at a time. */
nlohmann::json oneCellDocument() {
  return nlohmann::json{{"version", fixtureio::kConfigVersion},
                        {"gridWidth", 1},
                        {"gridHeight", 1},
                        {"rules", nlohmann::json::array()},
                        {"cells", {{0}}},
                        {"symbols", nlohmann::json::array()}};
}

TEST(LogicGridFixtureIo, ReadsTheCurrentVersion) {
  const TempFixture file(oneCellDocument());
  EXPECT_NO_THROW({ (void)fixtureio::load(file.path()); });
}

/** The same default the page applies, and what every board captured before the
 * tag existed depends on. */
TEST(LogicGridFixtureIo, TreatsAMissingVersionAsTheFirst) {
  nlohmann::json document = oneCellDocument();
  document.erase("version");
  const TempFixture file(document);
  EXPECT_NO_THROW({ (void)fixtureio::load(file.path()); });
}

/**
 * Refused rather than read as far as it parses. Migrating is the page's job —
 * it is the only side that reads files a stranger wrote — so a version these
 * tools do not know means this repo's own fixtures are out of step.
 */
TEST(LogicGridFixtureIo, RefusesAVersionItDoesNotKnow) {
  nlohmann::json document = oneCellDocument();
  document["version"] = fixtureio::kConfigVersion + 1;
  const TempFixture file(document);
  EXPECT_THROW((void)fixtureio::load(file.path()), fixtureio::FixtureError);
}

TEST(LogicGridFixtureIo, RefusesAVersionThatIsNotAnInteger) {
  nlohmann::json document = oneCellDocument();
  document["version"] = "1";
  const TempFixture file(document);
  EXPECT_THROW((void)fixtureio::load(file.path()), fixtureio::FixtureError);
}

/** The third writer of this format, alongside the page's own and
 * `validateConfig`'s rebuild — all three have to stamp it. */
TEST(LogicGridFixtureIo, WritesTheVersionItSaves) {
  const TempFixture file(oneCellDocument());
  const fixtureio::Fixture fixture = fixtureio::load(file.path());
  fixtureio::save(file.path(), fixture);
  const nlohmann::json written = readJson(file.path());
  ASSERT_TRUE(written.contains("version"));
  EXPECT_EQ(written.at("version").get<int>(), fixtureio::kConfigVersion);
}

/// A galaxy serialises as position and kind alone — no value, direction or
/// seat keys — and reads back identically. The writer sharing
/// `isValuelessKind` with the reader is what a stray `"value": 0` here would
/// have broken.
TEST(LogicGridFixtureIo, RoundTripsAGalaxy) {
  nlohmann::json document = oneCellDocument();
  document["symbols"] = nlohmann::json::array(
      {nlohmann::json{{"x", 0}, {"y", 0}, {"type", kClueGalaxy}}});
  const TempFixture file(document);
  const fixtureio::Fixture fixture = fixtureio::load(file.path());
  ASSERT_EQ(fixture.puzzle.clues.size(), 1U);
  EXPECT_EQ(fixture.puzzle.clues.front().kind, kClueGalaxy);
  fixtureio::save(file.path(), fixture);
  const nlohmann::json written = readJson(file.path());
  const nlohmann::json &symbol = written.at("symbols").front();
  EXPECT_EQ(symbol.at("type").get<int>(), kClueGalaxy);
  EXPECT_FALSE(symbol.contains("value"));
  EXPECT_FALSE(symbol.contains("direction"));
  EXPECT_FALSE(symbol.contains("seat"));
}

/// Refused rather than dropped: a value on a valueless kind would look like
/// part of the puzzle and change nothing about it.
TEST(LogicGridFixtureIo, RefusesAGalaxyWithAValue) {
  nlohmann::json document = oneCellDocument();
  document["symbols"] = nlohmann::json::array({nlohmann::json{
      {"x", 0}, {"y", 0}, {"type", kClueGalaxy}, {"value", 0}}});
  const TempFixture file(document);
  EXPECT_THROW((void)fixtureio::load(file.path()), fixtureio::FixtureError);
}

class LogicGridFixtureTest : public testing::TestWithParam<std::string> {};

TEST_P(LogicGridFixtureTest, SolvesAndVerifies) {
  const std::string &name = GetParam();
  const std::string path = std::string(TEST_RESOURCES_DIR) + "/" + name;

  fixtureio::Fixture fixture;
  std::string parseError;
  try {
    fixture = fixtureio::load(path);
  } catch (const fixtureio::FixtureError &error) {
    GTEST_SKIP() << error.what();
  } catch (const nlohmann::json::exception &error) {
    parseError = error.what();
  }
  ASSERT_TRUE(parseError.empty()) << parseError;
  ASSERT_EQ(structureProblem(fixture.puzzle), Problem::None)
      << describe(structureProblem(fixture.puzzle));

  const Model model = buildModel(fixture.puzzle);
  constexpr Config cfg{.maxMs = kBudgetMs};
  constexpr arms::ArmSpec spec{.engine = "cascade"};
  const Outcome outcome = arms::solve(model, spec, cfg);

  EXPECT_EQ(outcome.stats.oracleRejections, 0U);
  for (const Colors &witness : outcome.witnesses)
    EXPECT_EQ(verify::check(model, witness), verify::Violation::None);

  if (outcome.status == Status::Solved) {
    EXPECT_EQ(verify::check(model, outcome.colors), verify::Violation::None);
  }

  // The corpus is captured from a game that only ships solvable puzzles, so
  // "this board still comes out" is the sharpest thing to assert about it — and
  // the one nothing else here was checking. A plain board answers with a
  // complete colouring; an underclued one answers with the cells every solution
  // agrees on, which is a real answer only when it is PROVEN.
  //
  // There are no exceptions to this, and there should never be one. A captured
  // board that does not come out is either a mis-entry or a hole in the engine,
  // and both are worth a failing test rather than an entry on a list.
  const bool answered =
      outcome.status == Status::Solved ||
      (outcome.status == Status::Deduced && outcome.proven);
  // Through int, not straight to the underlying type: `Status` is a uint8_t,
  // and streaming one prints the CHARACTER with that code rather than a number.
  EXPECT_TRUE(answered)
      << "status " << static_cast<int>(std::to_underlying(outcome.status))
      << ", " << outcome.decided << " of " << model.playableCount
      << " cells decided";

  if (!fixture.hasSolution)
    return;

  // A generated board carries the colouring its clues were read off, which is
  // a solution by construction. Two things follow, and they are the sharpest
  // checks in the suite.
  EXPECT_EQ(verify::check(model, fixture.solution), verify::Violation::None)
      << "the fixture's own solution does not satisfy its clues";
  EXPECT_NE(outcome.status, Status::Unsolvable)
      << "a board with a witness was called unsolvable";

  if (outcome.status != Status::Deduced)
    return;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (outcome.colors[slot(i)] == kUnknown)
      continue;
    EXPECT_EQ(outcome.colors[slot(i)], fixture.solution[slot(i)])
        << "cell " << columnOf(i) << "," << rowOf(i)
        << " was reported forced against a known solution";
  }
}

INSTANTIATE_TEST_SUITE_P(
    LogicGrid, LogicGridFixtureTest, testing::ValuesIn(allTestFiles()),
    [](const testing::TestParamInfo<std::string> &info) {
      std::string name = info.param;
      name.erase(name.find(".json"));
      std::ranges::replace(name, '-', '_');
      return name;
    });

} // namespace
