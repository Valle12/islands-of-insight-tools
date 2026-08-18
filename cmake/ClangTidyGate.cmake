# Shared clang-tidy build gate for the C++ solvers under src/pages/*/a-star/.
#
# Usage, from a solver's own CMakeLists.txt (which must sit next to its
# .clang-tidy), before any add_executable/add_library:
#
#   include("${CMAKE_CURRENT_SOURCE_DIR}/../../../../cmake/ClangTidyGate.cmake")
#   clang_tidy_gate(OPTION SM_CLANG_TIDY PROFILE_LLVM 23)
#
#   OPTION       name of the user-facing on/off switch (default ON; turn off
#                for a fast iteration build, clang-tidy roughly doubles compile
#                time). Kept per-solver so an existing -D<NAME>=OFF keeps working.
#   PROFILE_LLVM major version the sibling .clang-tidy was generated against —
#                CLion's bundled clang-tidy. Bump it whenever the profile is
#                regenerated from a different CLion, or linting silently stops
#                (with a warning at configure time).
#
# On success this sets CMAKE_CXX_CLANG_TIDY in the CALLING directory, so every
# target declared afterwards runs the checks in .clang-tidy on every translation
# unit and FAILS the build on any finding — the tree cannot drift back out of
# compliance.
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
#     honors CXX_CLANG_TIDY for Makefile and Ninja). The VS-generator build
#     dirs therefore report that rather than pretending to run.
#   * The found binary is asked to validate .clang-tidy first, and /EHsc is
#     re-supplied on MSVC. See the two comments in the branches below.
#
# Every gate below degrades to a warning, never a hard configure error: the
# point is to check the code, and a setup that cannot check it should still
# build it.

macro(clang_tidy_gate)
    cmake_parse_arguments(_CTG "" "OPTION;PROFILE_LLVM" "" ${ARGN})

    if(NOT _CTG_OPTION)
        message(FATAL_ERROR "clang_tidy_gate: OPTION is required")
    endif()
    if(NOT _CTG_PROFILE_LLVM)
        message(FATAL_ERROR "clang_tidy_gate: PROFILE_LLVM is required")
    endif()

    option(${_CTG_OPTION}
           "Run clang-tidy as part of the build and fail on findings" ON)

    if(${_CTG_OPTION})
        # The config probe's verdict below is decided once, at configure time,
        # so CMake has to know that editing the profile invalidates it.
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                     "${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy")

        find_program(_CTG_EXE
            NAMES clang-tidy
            HINTS "$ENV{ProgramFiles}/JetBrains/CLion 2024.1.4/bin/clang/win/x64/bin"
                  "$ENV{ProgramFiles}/JetBrains/CLion/bin/clang/win/x64/bin"
        )

        set(_CTG_LLVM_MAJOR "")
        if(_CTG_EXE)
            execute_process(
                COMMAND "${_CTG_EXE}" --version
                OUTPUT_VARIABLE _CTG_VERSION_OUTPUT
                ERROR_VARIABLE _CTG_VERSION_OUTPUT
            )
            if(_CTG_VERSION_OUTPUT MATCHES "LLVM version ([0-9]+)")
                set(_CTG_LLVM_MAJOR "${CMAKE_MATCH_1}")
            endif()
        endif()

        set(_CTG_SKIP "")
        if(NOT _CTG_EXE)
            set(_CTG_SKIP "no clang-tidy was found")
        elseif(NOT _CTG_LLVM_MAJOR)
            set(_CTG_SKIP "the version of ${_CTG_EXE} could not be determined")
        elseif(CMAKE_GENERATOR MATCHES "Visual Studio")
            set(_CTG_SKIP "the '${CMAKE_GENERATOR}' generator ignores CXX_CLANG_TIDY -- configure with -G Ninja instead")
        elseif(NOT _CTG_LLVM_MAJOR STREQUAL _CTG_PROFILE_LLVM)
            # Checks are not portable across clang-tidy releases: names come and
            # go, and an implementation that survives gains and loses findings.
            # A tree that is clean under the version .clang-tidy was written for
            # can fail under another, which would break CI on code that is clean
            # locally and cannot be reproduced there. Lint only on the matching
            # major; other hosts still build and test.
            #
            # Measured on the GitHub ubuntu-24.04 runner's list: it puts an
            # unversioned clang-tidy 18 on PATH, and ten of the names these
            # profiles disable do not exist in 18. Nothing in apt ships 23 —
            # CLion's bundle is a development snapshot (23.0.0git) — so matching
            # CI to it is not possible anyway.
            set(_CTG_SKIP "the clang-tidy found is version ${_CTG_LLVM_MAJOR} while .clang-tidy was generated for ${_CTG_PROFILE_LLVM} -- update the PROFILE_LLVM argument in CMakeLists.txt if you regenerated the profile")
        else()
            # A matching major still does not prove the profile RUNS. It can be
            # rejected at the CONFIG level, and --warnings-as-errors=* turns that
            # into a fatal error on every single file — a build that reports
            # nothing about the code.
            #
            # Probe for that by running the real profile over an EMPTY
            # translation unit. Empty is the point: there is no code to have
            # findings, so any diagnostic that comes back is necessarily
            # config-level.
            #
            # --verify-config is the obvious candidate and is the wrong tool
            # here, measured both ways:
            #   * it FAILS on unknown check names, which are in fact harmless — a
            #     name the binary does not know is silently ignored at runtime,
            #     negated or not. Older clang-tidy would be rejected for nothing.
            #   * it PASSES the one thing that really does break every file: a
            #     deprecated check that is enabled while its replacement is
            #     disabled. That is exactly the shape both profiles have (see
            #     -performance-faster-string-find in each), and it reports
            #     "No config errors detected".
            set(_CTG_PROBE "${CMAKE_CURRENT_BINARY_DIR}/clang_tidy_probe.cpp")
            file(WRITE "${_CTG_PROBE}" "")
            execute_process(
                COMMAND "${_CTG_EXE}" --warnings-as-errors=*
                        "--config-file=${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy"
                        "${_CTG_PROBE}" -- -std=c++${CMAKE_CXX_STANDARD}
                RESULT_VARIABLE _CTG_CONFIG_RESULT
                OUTPUT_VARIABLE _CTG_CONFIG_OUTPUT
                ERROR_VARIABLE _CTG_CONFIG_OUTPUT
            )
            if(NOT _CTG_CONFIG_RESULT EQUAL 0)
                set(_CTG_SKIP "${_CTG_EXE} cannot run this tree's .clang-tidy: ${_CTG_CONFIG_OUTPUT}")
            endif()
        endif()

        if(_CTG_SKIP)
            message(WARNING "${_CTG_OPTION} is ON but ${_CTG_SKIP}; "
                            "the build will NOT be checked.")
        else()
            set(CMAKE_CXX_CLANG_TIDY "${_CTG_EXE}" --warnings-as-errors=*)
            if(MSVC)
                # clang-tidy silently DISCARDS every slash-prefixed flag it
                # receives after the `--` separator, which is how CMake hands it
                # the compile command. Measured with a controlled pair:
                # `-DFOO=1` reaches the preprocessor, `/DFOO=1` in the very same
                # position does not.
                #
                # Most of what CMake spells with a slash is irrelevant to
                # analysis (/nologo /TP /Zi /O1 /showIncludes /Fo /Fd /FS).
                # /EHsc is the one that matters: without it clang-tidy analyses
                # the tree as -fno-exceptions and reports every `try`/`throw` in
                # the tests as "cannot use 'throw' with exceptions disabled", a
                # clang-diagnostic-error that --warnings-as-errors=* makes fatal.
                #
                # Re-supply it through --extra-arg, which is spliced in at a
                # point the filter does not reach. Dash spelling (clang-cl
                # accepts both) so nothing downstream mistakes it for a path.
                list(APPEND CMAKE_CXX_CLANG_TIDY --extra-arg=-EHsc)
            endif()
            message(STATUS "clang-tidy enforced: ${_CTG_EXE}")
        endif()
    endif()
endmacro()
