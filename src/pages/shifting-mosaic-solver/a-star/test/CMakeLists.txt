add_executable(shifting_mosaic_a_star_tests
    astar_unit_test.cpp
    dragsolver_unit_test.cpp
    dragsolver_search_test.cpp
    json_test.cpp
    optimizer_test.cpp
)

# shifting_mosaic_core carries the solver objects, the include directory and the
# nlohmann / Threads usage requirements, so none of them are repeated here.
# Adding a target_compile_definitions to THIS target that a solver TU reads
# would break that sharing — TEST_RESOURCES_DIR below is referenced only from
# the five test TUs above, which is what makes one shared compile correct.
target_link_libraries(shifting_mosaic_a_star_tests PRIVATE
    shifting_mosaic_core
    GTest::gtest
    GTest::gtest_main
)

# PROJECT_SOURCE_DIR, not CMAKE_SOURCE_DIR: under the repo-root aggregate the
# latter is the repo root and this path would resolve outside the repo.
target_compile_definitions(shifting_mosaic_a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${PROJECT_SOURCE_DIR}/../../../../test/resources/shifting-mosaic-solver"
)

# 1200s absorbs shiftingMosaicTest37 on slow CI runners: its winning arm
# (deep flat drag) needs ~250s locally and the six-arm race contends for
# cores on hosted runners.
#
# PROCESSORS: every fixture here spawns ParallelCascade.h's ARMS (8) std::threads,
# so it claims 8 ctest slots — one per thread it actually runs. ctest then never
# oversubscribes: on a 4-vCPU runner 8 > -j so the test runs ALONE, and on a
# 16-core dev box `-j 16` allows two at a time. Without this, `ctest -j` runs
# them 4- or 16-wide, they starve each other, and test37 blows its per-arm
# budget — which looks like a regression and is not one.
#
# Keep in sync with ARMS in ../ParallelCascade.h.
set(SM_TEST_PROCESSORS 8 CACHE STRING
    "ctest slots each shifting-mosaic cascade test claims under -j")

gtest_discover_tests(shifting_mosaic_a_star_tests
    PROPERTIES TIMEOUT 1200
               LABELS "shifting-mosaic;cpp"
               PROCESSORS ${SM_TEST_PROCESSORS}
)
