cmake_minimum_required(VERSION 3.20)
project(islands_of_insight_solvers LANGUAGES CXX)

# An AGGREGATE, for CI and for "build everything once" locally:
#
#   cmake -B build-ci -S . -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
#   cmake --build build-ci -j
#   ctest --test-dir build-ci -j 4 --output-on-failure
#
# Each src/pages/*/a-star directory REMAINS independently configurable, and
# CLion's pre-configured dirs point straight at them. So nothing here may be
# something a child depends on: every line below is either a default the child
# already sets for itself, or purely additive. Anything a child needs belongs in
# that child's CMakeLists.txt.
#
# Per-page work from this dir: `cmake --build build-ci --target a_star_tests`
# and `ctest --test-dir build-ci -L rolling-blocks` (labels come from the two
# test/CMakeLists.txt).
#
# Note the children use PROJECT_SOURCE_DIR, never CMAKE_SOURCE_DIR — the latter
# is this directory once they are add_subdirectory'd, which would send
# TEST_RESOURCES_DIR outside the repo and make the fixture tests skip silently.

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(IOI_ROLLING_BLOCKS "Build the rolling-blocks solver" ON)
option(IOI_SHIFTING_MOSAIC "Build the shifting-mosaic solver" ON)
option(IOI_MATCH_THREE "Build the match-three solver" ON)

# Here rather than only in the children, so BUILD_TESTING exists and ctest
# collects both suites into this one build tree.
include(CTest)

if (IOI_ROLLING_BLOCKS)
    add_subdirectory(src/pages/rolling-blocks-solver/a-star)
endif ()

if (IOI_SHIFTING_MOSAIC)
    add_subdirectory(src/pages/shifting-mosaic-solver/a-star)
endif ()

if (IOI_MATCH_THREE)
    add_subdirectory(src/pages/match-three-solver/a-star)
endif ()
