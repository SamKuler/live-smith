cmake_minimum_required(VERSION 3.22)
project(LiveSmithView VERSION 0.1.5 LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Supply an installed JUCE CMake package or an independently obtained JUCE 8
# source tree. JUCE is not redistributed with this project.
find_package(JUCE CONFIG QUIET)
if (NOT JUCE_FOUND)
    if (NOT DEFINED LIVE_SMITH_JUCE_SOURCE_DIR OR
        NOT EXISTS "${LIVE_SMITH_JUCE_SOURCE_DIR}/CMakeLists.txt")
        message(FATAL_ERROR "Provide JUCE 8 via JUCE_DIR or LIVE_SMITH_JUCE_SOURCE_DIR")
    endif()
    add_subdirectory("${LIVE_SMITH_JUCE_SOURCE_DIR}" JUCE)
endif()

juce_add_plugin(LiveSmithView
    COMPANY_NAME "Live Smith"
    BUNDLE_ID "com.livesmith.view.vst3proof"
    PLUGIN_MANUFACTURER_CODE Lsmt
    PLUGIN_CODE Lsv3
    FORMATS VST3
    PRODUCT_NAME "Live Smith View"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
)

target_sources(LiveSmithView PRIVATE Source/LiveSmithView.cpp Source/PluginState.h Source/Vst3Broker.h)
target_compile_definitions(LiveSmithView PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_REPORT_APP_USAGE=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)
target_link_libraries(LiveSmithView PRIVATE
    juce::juce_audio_utils
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

include(CTest)
if (BUILD_TESTING)
    add_executable(LiveSmithStateTests tests/PluginStateTests.cpp)
    target_link_libraries(LiveSmithStateTests PRIVATE juce::juce_core)
    add_test(NAME LiveSmithStateTests COMMAND LiveSmithStateTests)
endif()
