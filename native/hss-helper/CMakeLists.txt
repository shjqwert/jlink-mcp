cmake_minimum_required(VERSION 3.20)
project(hss_helper LANGUAGES CXX)

add_executable(hss_helper hss_helper.cpp)
target_compile_features(hss_helper PRIVATE cxx_std_17)
