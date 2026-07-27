cmake_minimum_required(VERSION 3.20)
project(shifting_mosaic_a_star)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC's default Debug flags (/Od /Ob0 /RTC1) make STL-heavy code impractically
# slow. Enable basic optimizations while keeping debug info.
if(MSVC)
    string(REPLACE "/Od" "/O1" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/Ob0" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    # MSVC deprecates std::getenv (C4996) in favour of the non-portable
    # _dupenv_s. The env knobs in test/json_test.cpp are standard C++ and build
    # warning-free everywhere else, so silence the vendor-specific nag rather
    # than fork the code.
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS)
endif()

# The bench CLI (main.cpp) reads fixture JSONs directly.
find_package(nlohmann_json CONFIG REQUIRED)
# main.cpp runs the parallel cascade (ParallelCascade.h -> std::thread), so this
# target needs the threading library just like the test target does. Glibc 2.34+
# folded libpthread into libc so it happens to link on modern Ubuntu, but on any
# older toolchain it is an undefined-reference / std::system_error at runtime.
find_package(Threads REQUIRED)

# AStar.cpp and DragSolver.cpp are each split across several translation units
# (AStar*.cpp / DragSolver*.cpp) purely for file size; they define one class
# apiece and must always be compiled together.
add_executable(shifting_mosaic_a_star
    main.cpp
    BenchFixture.cpp
    BenchCommands.cpp
    SolverClock.cpp
    AStar.cpp
    AStarHeuristics.cpp
    AStarSearch.cpp
    AStarOptimizer.cpp
    DragSolver.cpp
    DragSolverHeuristics.cpp
    DragSolverSearch.cpp
    DragSolverExpand.cpp
    DragSolverAssembly.cpp
    DragSolverArms.cpp
    DragSolverBeam.cpp
)
target_link_libraries(shifting_mosaic_a_star PRIVATE nlohmann_json::nlohmann_json Threads::Threads)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()
