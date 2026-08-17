add_executable(logic_grid_tests
    puzzle_test.cpp
    rules_test.cpp
    verify_test.cpp
    propagate_test.cpp
    profile_test.cpp
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
# PROCESSORS 1 — the thread race here is __EMSCRIPTEN_PTHREADS__-only, so
# natively every arm is single-threaded and these parallelise freely.
gtest_discover_tests(logic_grid_tests
    PROPERTIES TIMEOUT 900 LABELS "logic-grid;cpp" PROCESSORS 1
)
