cmake_minimum_required(VERSION 3.20)
project(logic_grid)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC's default Debug flags (/Od /Ob0 /RTC1) make STL-heavy search code
# impractically slow. Enable basic optimizations while keeping debug info.
if(MSVC)
    string(REPLACE "/Od" "/O1" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/Ob0" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
endif()

# Runs .clang-tidy on every TU and fails the build on any finding. Shared with
# the other solvers — see cmake/ClangTidyGate.cmake for what each gate inside it
# is guarding against.
include("${CMAKE_CURRENT_SOURCE_DIR}/../../../../cmake/ClangTidyGate.cmake")
clang_tidy_gate(OPTION LG_CLANG_TIDY PROFILE_LLVM 23)

# No Boost, like match-three: nothing in this search needs it, and
# buildWasm.ts passes needsBoost:false to match.
find_package(nlohmann_json CONFIG REQUIRED)

# Compiled ONCE and consumed by both the CLI and the gtest binary.
#
# FixtureIo.cpp and Reference.cpp belong here because both native targets use
# them — but they must never join the wasm source list in
# src/util/buildWasm.ts. FixtureIo needs nlohmann and exceptions, which that
# build has neither of, and Reference is exponential brute force that must not
# be reachable from the page at all.
add_library(logic_grid_core OBJECT
        Rules.cpp
        Puzzle.cpp
        Regions.cpp
        Verify.cpp
        Propagate.cpp
        Probe.cpp
        Search.cpp
        Profile.cpp
        Underclued.cpp
        SolverArms.cpp
        SolverClock.cpp
        FixtureIo.cpp
        Reference.cpp)
target_include_directories(logic_grid_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(logic_grid_core PUBLIC nlohmann_json::nlohmann_json)

# GenerateCommands.cpp stays out of the core: only the CLI's --generate path
# uses it, and the test binary has no reason to link it.
add_executable(logic_grid main.cpp GenerateCommands.cpp)
target_link_libraries(logic_grid PRIVATE logic_grid_core)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()
