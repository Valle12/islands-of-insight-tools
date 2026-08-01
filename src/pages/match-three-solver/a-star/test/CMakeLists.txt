add_executable(match_three_tests
    rules_test.cpp
    table_test.cpp
    search_test.cpp
    fixtures_test.cpp
)

# match_three_core carries the solver objects, the include directory and the
# nlohmann usage requirement, so none of them are repeated here. Adding a
# target_compile_definitions to THIS target that a solver TU reads would break
# that sharing — TEST_RESOURCES_DIR below is referenced only from the test TUs
# above, which is what makes one shared compile correct.
target_link_libraries(match_three_tests PRIVATE
    match_three_core
    GTest::gtest
    GTest::gtest_main
)

# PROJECT_SOURCE_DIR, not CMAKE_SOURCE_DIR: under the repo-root aggregate the
# latter is the repo root, and this path would resolve outside the repo — where
# the fixture tests GTEST_SKIP instead of failing, i.e. a silently green run.
target_compile_definitions(match_three_tests PRIVATE
    TEST_RESOURCES_DIR="${PROJECT_SOURCE_DIR}/../../../../test/resources/match-three-solver"
)

# LABELS lets one page's suite run on its own: ctest -L match-three.
# PROCESSORS 1 — every arm here is single-threaded, so these parallelise
# freely, unlike the shifting-mosaic cascade tests.
gtest_discover_tests(match_three_tests
    PROPERTIES TIMEOUT 600 LABELS "match-three;cpp" PROCESSORS 1
)
