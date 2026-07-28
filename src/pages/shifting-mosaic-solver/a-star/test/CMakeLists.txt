add_executable(shifting_mosaic_a_star_tests
    astar_unit_test.cpp
    dragsolver_unit_test.cpp
    dragsolver_search_test.cpp
    json_test.cpp
    optimizer_test.cpp
    ${CMAKE_SOURCE_DIR}/SolverClock.cpp
    ${CMAKE_SOURCE_DIR}/AStar.cpp
    ${CMAKE_SOURCE_DIR}/AStarHeuristics.cpp
    ${CMAKE_SOURCE_DIR}/AStarSearch.cpp
    ${CMAKE_SOURCE_DIR}/AStarOptimizer.cpp
    ${CMAKE_SOURCE_DIR}/DragSolver.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverHeuristics.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverSearch.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverExpand.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverAssembly.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverArms.cpp
    ${CMAKE_SOURCE_DIR}/DragSolverBeam.cpp
)

find_package(Threads REQUIRED)

target_link_libraries(shifting_mosaic_a_star_tests PRIVATE
    GTest::gtest
    GTest::gtest_main
    nlohmann_json::nlohmann_json
    Threads::Threads
)

target_include_directories(shifting_mosaic_a_star_tests PRIVATE ${CMAKE_SOURCE_DIR})

target_compile_definitions(shifting_mosaic_a_star_tests PRIVATE
    TEST_RESOURCES_DIR="${CMAKE_SOURCE_DIR}/../../../../test/resources/shifting-mosaic-solver"
)

# 1200s absorbs shiftingMosaicTest37 on slow CI runners: its winning arm
# (deep flat drag) needs ~250s locally and the six-arm race contends for
# cores on hosted runners.
gtest_discover_tests(shifting_mosaic_a_star_tests
    PROPERTIES TIMEOUT 1200
)
