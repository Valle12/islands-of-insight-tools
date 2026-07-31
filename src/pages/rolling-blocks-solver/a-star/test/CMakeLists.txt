add_executable(a_star_tests
    block_test.cpp
    rolling_blocks_test.cpp
    state_encoding_test.cpp
    optimizer_test.cpp
    arms_test.cpp
    ${PROJECT_SOURCE_DIR}/Block.cpp
    ${PROJECT_SOURCE_DIR}/AStar.cpp
    ${PROJECT_SOURCE_DIR}/AStarGoals.cpp
    ${PROJECT_SOURCE_DIR}/AStarOptimizer.cpp
    ${PROJECT_SOURCE_DIR}/SearchCracker.cpp
    ${PROJECT_SOURCE_DIR}/SearchBeam.cpp
    ${PROJECT_SOURCE_DIR}/SolverArms.cpp
    ${PROJECT_SOURCE_DIR}/SolverClock.cpp
    ${PROJECT_SOURCE_DIR}/Replay.cpp
    ${PROJECT_SOURCE_DIR}/FixtureIo.cpp
)

target_link_libraries(a_star_tests PRIVATE
    GTest::gtest
    GTest::gtest_main
    Boost::boost
    nlohmann_json::nlohmann_json
)

target_include_directories(a_star_tests PRIVATE ${PROJECT_SOURCE_DIR})

# Pass the path to the test resources directory
target_compile_definitions(a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${PROJECT_SOURCE_DIR}/../../../../test/resources/rolling-blocks-solver"
)

gtest_discover_tests(a_star_tests
    PROPERTIES TIMEOUT 300
)
