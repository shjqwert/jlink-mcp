cmake_minimum_required(VERSION 3.20)
project(jlink_capture_helper LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "jlink-capture-helper requires Windows x64")
endif()

add_executable(jlink-capture-helper main.cpp)
target_compile_features(jlink-capture-helper PRIVATE cxx_std_20)
target_compile_definitions(jlink-capture-helper PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_compile_options(jlink-capture-helper PRIVATE /W4 /WX /permissive- /EHsc)
target_link_libraries(jlink-capture-helper PRIVATE ws2_32)
