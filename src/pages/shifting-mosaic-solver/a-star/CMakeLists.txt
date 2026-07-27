cmake_minimum_required(VERSION 3.20)
project(shifting_mosaic_a_star)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC's default Debug flags (/Od /Ob0 /RTC1) make STL-heavy code impractically
# slow. Enable basic optimizations while keeping debug info.
if(MSVC)
    string(REPLACE "/Od" "/O1" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/Ob0" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    # MSVC deprecates std::getenv (C4996) in favour of the non-portable
    # _dupenv_s. The env knobs in test/json_test.cpp are standard C++ and build
    # warning-free everywhere else, so silence the vendor-specific nag rather
    # than fork the code.
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS)
endif()

# --- clang-tidy in the build -------------------------------------------------
#
# Runs the checks in .clang-tidy on every translation unit and FAILS the build
# on any finding, so the tree cannot drift back out of compliance.
#
# This differs from the usual snippet you find online
# (set(CMAKE_CXX_CLANG_TIDY clang-tidy; -checks=*; -warnings-as-errors=*)) in
# four ways, each of which was a real failure here before it was handled:
#
#   * No -checks argument. Passing -checks=* on the command line OVERRIDES
#     .clang-tidy entirely and turns on every check clang-tidy ships —
#     including the mutually contradictory llvm-*, fuchsia-* and altera-*
#     families. Omitting it lets .clang-tidy stay the single source of truth.
#   * The executable is looked up rather than assumed. Plain `clang-tidy` is
#     not on PATH on this machine; CLion ships one, so search there too.
#   * It is a no-op under the Visual Studio generator (verified: CMake only
#     honours CXX_CLANG_TIDY for Makefile and Ninja). build-native uses the VS
#     generator, so the gate below reports that rather than pretending to run.
#   * The found binary is asked to validate .clang-tidy first, and /EHsc is
#     re-supplied on MSVC. See the two comments in the branches below.
#
# Every gate below degrades to a warning, never a hard configure error: the
# point is to check the code, and a setup that cannot check it should still
# build it.
#
# Turn off for a fast iteration build with -DSM_CLANG_TIDY=OFF; clang-tidy
# roughly doubles compile time.
option(SM_CLANG_TIDY "Run clang-tidy as part of the build and fail on findings"
       ON)
if(SM_CLANG_TIDY)
    # The --verify-config verdict below is decided once, at configure time, so
    # CMake has to know that editing the profile invalidates it.
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                 "${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy")
    find_program(SM_CLANG_TIDY_EXE
        NAMES clang-tidy
        HINTS "$ENV{ProgramFiles}/JetBrains/CLion 2024.1.4/bin/clang/win/x64/bin"
              "$ENV{ProgramFiles}/JetBrains/CLion/bin/clang/win/x64/bin"
    )
    # Major version .clang-tidy was generated against — CLion 2024.1.4's bundled
    # clang-tidy. Bump this whenever the profile is regenerated from a different
    # CLion, or linting silently stops (with a warning at configure time).
    set(SM_CLANG_TIDY_PROFILE_LLVM 23)
    set(SM_TIDY_LLVM_MAJOR "")
    if(SM_CLANG_TIDY_EXE)
        execute_process(
            COMMAND "${SM_CLANG_TIDY_EXE}" --version
            OUTPUT_VARIABLE SM_TIDY_VERSION_OUTPUT
            ERROR_VARIABLE SM_TIDY_VERSION_OUTPUT
        )
        if(SM_TIDY_VERSION_OUTPUT MATCHES "LLVM version ([0-9]+)")
            set(SM_TIDY_LLVM_MAJOR "${CMAKE_MATCH_1}")
        endif()
    endif()

    set(SM_TIDY_SKIP "")
    if(NOT SM_CLANG_TIDY_EXE)
        set(SM_TIDY_SKIP "no clang-tidy was found")
    elseif(NOT SM_TIDY_LLVM_MAJOR)
        set(SM_TIDY_SKIP "the version of ${SM_CLANG_TIDY_EXE} could not be determined")
    elseif(CMAKE_GENERATOR MATCHES "Visual Studio")
        set(SM_TIDY_SKIP "the '${CMAKE_GENERATOR}' generator ignores CXX_CLANG_TIDY -- configure with -G Ninja instead")
    elseif(NOT SM_TIDY_LLVM_MAJOR STREQUAL SM_CLANG_TIDY_PROFILE_LLVM)
        # Checks are not portable across clang-tidy releases: names come and go,
        # and an implementation that survives gains and loses findings. A tree
        # that is clean under the version .clang-tidy was written for can fail
        # under another, which would break CI on code that is clean locally and
        # cannot be reproduced there. Lint only on the matching major; other
        # hosts still build and test.
        #
        # Measured on the GitHub ubuntu-24.04 runner's list: it puts an
        # unversioned clang-tidy 18 on PATH, and ten of the names this profile
        # disables do not exist in 18. Nothing in apt ships 23 — CLion's bundle
        # is a development snapshot (23.0.0git) — so matching CI to it is not
        # possible anyway.
        set(SM_TIDY_SKIP "the clang-tidy found is version ${SM_TIDY_LLVM_MAJOR} while .clang-tidy was generated for ${SM_CLANG_TIDY_PROFILE_LLVM} -- update SM_CLANG_TIDY_PROFILE_LLVM in CMakeLists.txt if you regenerated the profile")
    else()
        # A matching major still does not prove the profile RUNS. It can be
        # rejected at the CONFIG level, and --warnings-as-errors=* turns that
        # into a fatal error on every single file — a build that reports
        # nothing about the code.
        #
        # Probe for that by running the real profile over an EMPTY translation
        # unit. Empty is the point: there is no code to have findings, so any
        # diagnostic that comes back is necessarily config-level.
        #
        # --verify-config is the obvious candidate and is the wrong tool here,
        # measured both ways:
        #   * it FAILS on unknown check names, which are in fact harmless — a
        #     name the binary does not know is silently ignored at runtime,
        #     negated or not. Older clang-tidy would be rejected for nothing.
        #   * it PASSES the one thing that really does break every file: a
        #     deprecated check that is enabled while its replacement is
        #     disabled. That is exactly this profile's shape, and it reports
        #     "No config errors detected".
        set(SM_TIDY_PROBE "${CMAKE_CURRENT_BINARY_DIR}/sm_tidy_probe.cpp")
        file(WRITE "${SM_TIDY_PROBE}" "")
        execute_process(
            COMMAND "${SM_CLANG_TIDY_EXE}" --warnings-as-errors=*
                    "--config-file=${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy"
                    "${SM_TIDY_PROBE}" -- -std=c++${CMAKE_CXX_STANDARD}
            RESULT_VARIABLE SM_TIDY_CONFIG_RESULT
            OUTPUT_VARIABLE SM_TIDY_CONFIG_OUTPUT
            ERROR_VARIABLE SM_TIDY_CONFIG_OUTPUT
        )
        if(NOT SM_TIDY_CONFIG_RESULT EQUAL 0)
            set(SM_TIDY_SKIP "${SM_CLANG_TIDY_EXE} cannot run this tree's .clang-tidy: ${SM_TIDY_CONFIG_OUTPUT}")
        endif()
    endif()

    if(SM_TIDY_SKIP)
        message(WARNING "SM_CLANG_TIDY is ON but ${SM_TIDY_SKIP}; "
                        "the build will NOT be checked.")
    else()
        set(CMAKE_CXX_CLANG_TIDY "${SM_CLANG_TIDY_EXE}" --warnings-as-errors=*)
        if(MSVC)
            # clang-tidy silently DISCARDS every slash-prefixed flag it receives
            # after the `--` separator, which is how CMake hands it the compile
            # command. Measured with a controlled pair: `-DFOO=1` reaches the
            # preprocessor, `/DFOO=1` in the very same position does not.
            #
            # Most of what CMake spells with a slash is irrelevant to analysis
            # (/nologo /TP /Zi /O1 /showIncludes /Fo /Fd /FS), and the two
            # dropped defines /DWIN32 /D_WINDOWS are unused here — MemoryProbe.h
            # tests _WIN32, which clang-cl predefines itself. /EHsc is the one
            # that matters: without it clang-tidy analyses the tree as
            # -fno-exceptions and reports every `try`/`throw` in the tests as
            # "cannot use 'throw' with exceptions disabled", a
            # clang-diagnostic-error that --warnings-as-errors=* makes fatal.
            #
            # Re-supply it through --extra-arg, which is spliced in at a point
            # the filter does not reach. Dash spelling (clang-cl accepts both) so
            # nothing downstream mistakes it for a path.
            list(APPEND CMAKE_CXX_CLANG_TIDY --extra-arg=-EHsc)
        endif()
        message(STATUS "clang-tidy enforced: ${SM_CLANG_TIDY_EXE}")
    endif()
endif()

# The bench CLI (main.cpp) reads fixture JSONs directly.
find_package(nlohmann_json CONFIG REQUIRED)
# main.cpp runs the parallel cascade (ParallelCascade.h -> std::thread), so this
# target needs the threading library just like the test target does. Glibc 2.34+
# folded libpthread into libc so it happens to link on modern Ubuntu, but on any
# older toolchain it is an undefined-reference / std::system_error at runtime.
find_package(Threads REQUIRED)

# AStar.cpp and DragSolver.cpp are each split across several translation units
# (AStar*.cpp / DragSolver*.cpp) purely for file size; they define one class
# apiece and must always be compiled together.
add_executable(shifting_mosaic_a_star
    main.cpp
    BenchFixture.cpp
    BenchCommands.cpp
    SolverClock.cpp
    AStar.cpp
    AStarHeuristics.cpp
    AStarSearch.cpp
    AStarOptimizer.cpp
    DragSolver.cpp
    DragSolverHeuristics.cpp
    DragSolverSearch.cpp
    DragSolverExpand.cpp
    DragSolverAssembly.cpp
    DragSolverArms.cpp
    DragSolverBeam.cpp
)
target_link_libraries(shifting_mosaic_a_star PRIVATE nlohmann_json::nlohmann_json Threads::Threads)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()
