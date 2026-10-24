#include "../Source/PluginState.h"
#include "../Source/Vst3Broker.h"
#include <array>

int main()
{
    juce::MemoryBlock fresh;
    liveSmith::writeCredentialFreeState (fresh);
    if (! fresh.isEmpty()) return 1;

    juce::MemoryBlock dirty ("previous state", 14);
    liveSmith::writeCredentialFreeState (dirty);
    if (! dirty.isEmpty()) return 2;

    for (const auto* legacy : std::array {
             "http://127.0.0.1:4620/chat?token=legacy-secret",
             "http://127.0.0.1:4620/chat?launch=legacy-ticket"
         })
    {
        juce::MemoryBlock restored;
        {
            juce::MemoryOutputStream oldSerializer (restored, true);
            oldSerializer.writeString (legacy);
        }
        liveSmith::ignoreLegacyState (restored.getData(), static_cast<int> (restored.getSize()));
        liveSmith::ignoreLegacyState (nullptr, 0);
        juce::MemoryBlock nextSave (restored);
        liveSmith::writeCredentialFreeState (nextSave);
        if (! nextSave.isEmpty()) return 3;
    }
    const auto valid = liveSmith::parseBrokerDescriptor (
        R"({"version":1,"bridgeId":"123e4567-e89b-12d3-a456-426614174000","capability":"123e4567-e89b-12d3-a456-426614174000123e4567-e89b-12d3-a456-426614174001","port":4620})");
    if (! valid || ! liveSmith::isLaunchUrlFor (
            "http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174002", *valid)) return 4;
    if (liveSmith::parseBrokerDescriptor (
            R"({"version":1,"bridgeId":"bad","capability":"secret","port":4620})")) return 5;
    if (liveSmith::isLaunchUrlFor ("http://127.0.0.1:4620/chat?token=secret", *valid)) return 6;
    if (liveSmith::isLaunchUrlFor (
            "http://127.0.0.1:4621/chat?launch=123e4567-e89b-12d3-a456-426614174002", *valid)) return 7;
    return 0;
}
