cmake_minimum_required(VERSION 3.20)
project(hss_helper LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "hss_helper currently supports Windows only")
endif()
if(NOT MSVC)
  message(FATAL_ERROR "hss_helper release builds require the Microsoft C++ toolchain")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "hss_helper requires a 64-bit compiler")
endif()

set(HSS_HELPER_VERSION "1.1.2" CACHE STRING "HSS Helper product version")

add_executable(hss_helper hss_helper.cpp)
target_compile_features(hss_helper PRIVATE cxx_std_17)
target_compile_definitions(hss_helper PRIVATE HSS_HELPER_VERSION="${HSS_HELPER_VERSION}" HSS_HELPER_PROTOCOL_VERSION=2)
set_property(TARGET hss_helper PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
target_link_libraries(hss_helper PRIVATE bcrypt)
add_custom_command(TARGET hss_helper POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:hss_helper>" "${CMAKE_CURRENT_SOURCE_DIR}/bin/hss_helper.exe"
)
