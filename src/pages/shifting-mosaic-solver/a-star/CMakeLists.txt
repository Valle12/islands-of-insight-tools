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
endif()

# The bench CLI (main.cpp) reads fixture JSONs directly.
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(shifting_mosaic_a_star main.cpp AStar.cpp DragSolver.cpp)
target_link_libraries(shifting_mosaic_a_star PRIVATE nlohmann_json::nlohmann_json)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()
