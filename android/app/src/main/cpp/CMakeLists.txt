cmake_minimum_required(VERSION 3.22.1)
project(doge_wasm_jni C)

add_library(iwasm SHARED IMPORTED)
set_target_properties(iwasm PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../jniLibs/${ANDROID_ABI}/libiwasm.so"
    INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/wamr/include"
)

add_library(doge_wasm_jni SHARED wasm_runner.c)
target_link_libraries(doge_wasm_jni iwasm log)
target_compile_options(doge_wasm_jni PRIVATE -Wall -Wextra -Werror=return-type)
