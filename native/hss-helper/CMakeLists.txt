cmake_minimum_required(VERSION 3.20)
project(hss_helper LANGUAGES CXX)

add_executable(hss_helper hss_helper.cpp)
target_compile_features(hss_helper PRIVATE cxx_std_17)
target_compile_definitions(hss_helper PRIVATE HSS_HELPER_VERSION="1" HSS_HELPER_PROTOCOL_VERSION=1)
target_link_libraries(hss_helper PRIVATE bcrypt)
add_custom_command(TARGET hss_helper POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:hss_helper>" "${CMAKE_CURRENT_SOURCE_DIR}/bin/hss_helper.exe"
)
