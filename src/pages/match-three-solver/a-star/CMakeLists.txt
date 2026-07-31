cmake_minimum_required(VERSION 3.20)
project(match_three)

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
clang_tidy_gate(OPTION MT_CLANG_TIDY PROFILE_LLVM 23)

# No Boost here, unlike the other two solvers: nothing in this search needs it,
# and buildWasm.ts passes needsBoost:false to match.
find_package(nlohmann_json CONFIG REQUIRED)

# Compiled ONCE and consumed by both the CLI and the gtest binary. FixtureIo.cpp
# belongs here because both native targets use it — but it must never join the
# wasm source list in src/util/buildWasm.ts, which is exception-free and has no
# nlohmann.
add_library(match_three_core OBJECT
        Rules.cpp Replay.cpp SearchProver.cpp SearchGreedy.cpp
        SearchBeam.cpp SolverArms.cpp SolverClock.cpp FixtureIo.cpp)
target_include_directories(match_three_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(match_three_core PUBLIC nlohmann_json::nlohmann_json)

# GenerateCommands.cpp stays out of the core: only the CLI's --generate path
# uses it, and the test binary has no reason to link it.
add_executable(match_three main.cpp GenerateCommands.cpp)
target_link_libraries(match_three PRIVATE match_three_core)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()
