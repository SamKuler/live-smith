#pragma once

#include <juce_core/juce_core.h>

namespace liveSmith
{
// The view has no persistent parameters. In particular, bridge URLs and
// one-use launch credentials must never be serialized into a Live Set.
inline void writeCredentialFreeState (juce::MemoryBlock& destination)
{
    destination.reset();
}

// Older proof builds saved an authenticated URL. It is untrusted historical
// state and must not be used for discovery, navigation, or future saves.
inline void ignoreLegacyState (const void*, int) noexcept {}
}
