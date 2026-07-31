cmake_minimum_required(VERSION 3.20)
project(a_star)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC's default Debug flags (/Od /Ob0 /RTC1) make STL/Boost-heavy code
# impractically slow. Enable basic optimizations while keeping debug info.
if(MSVC)
    string(REPLACE "/Od" "/O1" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/Ob0" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
endif()

# Runs .clang-tidy on every TU and fails the build on any finding. Shared with
# the other solvers — see cmake/ClangTidyGate.cmake for what each gate inside it
# is guarding against, and add the same two lines to any new solver.
include("${CMAKE_CURRENT_SOURCE_DIR}/../../../../cmake/ClangTidyGate.cmake")
clang_tidy_gate(OPTION RB_CLANG_TIDY PROFILE_LLVM 23)

find_package(Boost CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

# Compiled ONCE and consumed by both the CLI and the gtest binary. These TUs
# used to be listed in both targets, so every one of them was compiled (and
# clang-tidied) twice per build. FixtureIo.cpp belongs here because both native
# targets use it — but it must never join the wasm source list in
# src/util/buildWasm.ts, which is exception-free and has no nlohmann.
add_library(a_star_core OBJECT
        Block.cpp AStar.cpp AStarGoals.cpp AStarOptimizer.cpp
        SearchCracker.cpp SearchBeam.cpp SolverArms.cpp
        SolverClock.cpp Replay.cpp FixtureIo.cpp)
target_include_directories(a_star_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(a_star_core PUBLIC Boost::boost nlohmann_json::nlohmann_json)

# GenerateCommands.cpp stays out of the core: only the CLI's --generate path
# uses it, and the test binary has no reason to link it.
add_executable(a_star main.cpp GenerateCommands.cpp)
target_link_libraries(a_star PRIVATE a_star_core)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()

