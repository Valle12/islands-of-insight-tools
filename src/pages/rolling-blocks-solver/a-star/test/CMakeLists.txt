add_executable(a_star_tests
    block_test.cpp
    rolling_blocks_test.cpp
    state_encoding_test.cpp
    optimizer_test.cpp
    arms_test.cpp
)

# a_star_core carries the solver objects, the include directory and the Boost /
# nlohmann usage requirements, so none of them are repeated here. Adding a
# target_compile_definitions to THIS target that a solver TU reads would break
# that sharing — TEST_RESOURCES_DIR below is referenced only from the five test
# TUs above, which is what makes one shared compile correct.
target_link_libraries(a_star_tests PRIVATE
    a_star_core
    GTest::gtest
    GTest::gtest_main
)

# Pass the path to the test resources directory.
# PROJECT_SOURCE_DIR, not CMAKE_SOURCE_DIR: under the repo-root aggregate the
# latter is the repo root, and this path would resolve outside the repo — where
# the fixture tests GTEST_SKIP instead of failing, i.e. a silently green run.
target_compile_definitions(a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${PROJECT_SOURCE_DIR}/../../../../test/resources/rolling-blocks-solver"
)

# LABELS lets one page's suite run on its own: ctest -L rolling-blocks.
# PROCESSORS 1 — these are cheap and parallelise freely, unlike the
# shifting-mosaic cascade tests.
gtest_discover_tests(a_star_tests
    PROPERTIES TIMEOUT 300 LABELS "rolling-blocks;cpp" PROCESSORS 1
)
