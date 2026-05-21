add_executable(shifting_mosaic_a_star_tests
    astar_unit_test.cpp
    json_test.cpp
    optimizer_test.cpp
    ${CMAKE_SOURCE_DIR}/AStar.cpp
)

target_link_libraries(shifting_mosaic_a_star_tests PRIVATE
    GTest::gtest
    GTest::gtest_main
    nlohmann_json::nlohmann_json
)

target_include_directories(shifting_mosaic_a_star_tests PRIVATE ${CMAKE_SOURCE_DIR})

target_compile_definitions(shifting_mosaic_a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${CMAKE_SOURCE_DIR}/../../../../test/resources"
)

gtest_discover_tests(shifting_mosaic_a_star_tests
    PROPERTIES TIMEOUT 600
)
