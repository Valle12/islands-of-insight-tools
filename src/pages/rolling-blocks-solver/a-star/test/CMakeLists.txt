add_executable(a_star_tests
    block_test.cpp
    bfs_test.cpp
    ${CMAKE_SOURCE_DIR}/Block.cpp
    ${CMAKE_SOURCE_DIR}/AStar.cpp
)

target_link_libraries(a_star_tests PRIVATE
    GTest::gtest
    GTest::gtest_main
    Boost::boost
    nlohmann_json::nlohmann_json
)

target_include_directories(a_star_tests PRIVATE ${CMAKE_SOURCE_DIR})

# Pass the path to the test resources directory
target_compile_definitions(a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${CMAKE_SOURCE_DIR}/../../../../test/resources"
)

gtest_discover_tests(a_star_tests
    PROPERTIES TIMEOUT 300
)
