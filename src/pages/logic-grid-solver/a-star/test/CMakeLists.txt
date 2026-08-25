add_executable(logic_grid_tests
    puzzle_test.cpp
    rules_test.cpp
    verify_test.cpp
    propagate_test.cpp
    profile_test.cpp
    underclued_test.cpp
    routing_test.cpp
    packing_test.cpp
    reference_test.cpp
    fixtures_test.cpp
)

# logic_grid_core carries the solver objects, the include directory and the
# nlohmann usage requirement, so none of them are repeated here. Adding a
# target_compile_definitions to THIS target that a solver TU reads would break
# that sharing — TEST_RESOURCES_DIR below is referenced only from the test TUs
# above, which is what makes one shared compile correct.
target_link_libraries(logic_grid_tests PRIVATE
    logic_grid_core
    GTest::gtest
    GTest::gtest_main
)

# PROJECT_SOURCE_DIR, not CMAKE_SOURCE_DIR: under the repo-root aggregate the
# latter is the repo root, and this path would resolve outside the repo — where
# the fixture tests GTEST_SKIP instead of failing, i.e. a silently green run.
target_compile_definitions(logic_grid_tests PRIVATE
    TEST_RESOURCES_DIR="${PROJECT_SOURCE_DIR}/../../../../test/resources/logic-grid-solver"
)

# LABELS lets one page's suite run on its own: ctest -L logic-grid.
#
# NOT gtest_discover_tests, unlike the other three suites. That registers
# every gtest case as its own ctest entry, and this binary carries ~9000 of
# them (the fixture sweep times the rule sets), so under ctest each one cost a
# process start that registered all ~9000 again: 80 ms apiece, 877 of the
# 1665 CPU-seconds of CI's whole ctest step, against ~250 s of real solver
# work (measured 2026-08-25 on the 4-vCPU runners). Instead the binary runs
# in-process as LG_TEST_SHARDS ctest entries, each taking a slice through
# gtest's own sharding protocol (GTEST_TOTAL_SHARDS / GTEST_SHARD_INDEX),
# which still runs and reports every case. CLion's gtest runner drives the
# binary directly and is unaffected; `ctest -L logic-grid` runs the shards.
#
# PROCESSORS 1 — the thread race here is __EMSCRIPTEN_PTHREADS__-only, so
# natively every arm is single-threaded and the shards parallelise freely.
set(LG_TEST_SHARDS 4 CACHE STRING
    "ctest entries the logic-grid gtest binary is split into (gtest sharding)")
math(EXPR LG_LAST_SHARD "${LG_TEST_SHARDS} - 1")
foreach (shard RANGE 0 ${LG_LAST_SHARD})
    add_test(NAME logic_grid_tests_shard_${shard} COMMAND logic_grid_tests)
    set_tests_properties(logic_grid_tests_shard_${shard} PROPERTIES
        ENVIRONMENT "GTEST_TOTAL_SHARDS=${LG_TEST_SHARDS};GTEST_SHARD_INDEX=${shard}"
        TIMEOUT 1800
        LABELS "logic-grid;cpp"
        PROCESSORS 1
    )
endforeach ()
