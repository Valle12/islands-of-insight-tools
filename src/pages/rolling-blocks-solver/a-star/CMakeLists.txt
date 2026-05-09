cmake_minimum_required(VERSION 3.20)
project(a_star)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC's default Debug flags (/Od /Ob0 /RTC1) make STL/Boost-heavy code
# impractically slow. Enable basic optimizations while keeping debug info.
if(MSVC)
    string(REPLACE "/Od" "/O1" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/Ob0" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
endif()

add_executable(a_star main.cpp Block.cpp AStar.cpp)

find_package(Boost CONFIG REQUIRED)
target_link_libraries(a_star PRIVATE Boost::boost)

find_package(nlohmann_json CONFIG REQUIRED)

include(CTest)
if (BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    add_subdirectory(test)
endif ()

