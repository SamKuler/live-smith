#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <optional>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace liveSmith
{
struct BrokerDescriptor
{
    juce::String bridgeId;
    juce::String capability;
    int port = 0;
};

inline bool isUuid (const juce::String& value)
{
    if (value.length() != 36) return false;
    for (int i = 0; i < 36; ++i)
    {
        const auto c = value[i];
        if (i == 8 || i == 13 || i == 18 || i == 23)
        {
            if (c != '-') return false;
        }
        else if (! ((c >= '0' && c <= '9') ||
                   (c >= 'a' && c <= 'f') ||
                   (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}

inline std::optional<BrokerDescriptor> parseBrokerDescriptor (const juce::String& text)
{
    const auto value = juce::JSON::parse (text);
    const auto* object = value.getDynamicObject();
    if (object == nullptr || object->getProperties().size() != 4 ||
        ! object->getProperty ("version").isInt() ||
        static_cast<int> (object->getProperty ("version")) != 1 ||
        ! object->getProperty ("port").isInt()) return {};
    BrokerDescriptor result {
        object->getProperty ("bridgeId").toString(),
        object->getProperty ("capability").toString(),
        static_cast<int> (object->getProperty ("port"))
    };
    if (! isUuid (result.bridgeId) || result.capability.length() != 72 ||
        ! isUuid (result.capability.substring (0, 36)) ||
        ! isUuid (result.capability.substring (36)) ||
        result.port < 1 || result.port > 65535) return {};
    return result;
}

inline juce::File brokerDirectory()
{
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
        .getChildFile ("Ableton").getChildFile ("Extensions Data")
        .getChildFile ("sam-kuler.live-smith").getChildFile ("vst3-view");
}

inline std::optional<BrokerDescriptor> readBrokerDescriptor()
{
    const auto directory = brokerDirectory().getFullPathName();
    const auto directoryFd = ::open (directory.toRawUTF8(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (directoryFd < 0) return {};
    struct stat directoryInfo {};
    if (::fstat (directoryFd, &directoryInfo) != 0 || ! S_ISDIR (directoryInfo.st_mode) ||
        directoryInfo.st_uid != ::geteuid() || (directoryInfo.st_mode & 0077) != 0)
    {
        ::close (directoryFd);
        return {};
    }
    const auto fileFd = ::openat (directoryFd, "bridge.json", O_RDONLY | O_NOFOLLOW);
    ::close (directoryFd);
    if (fileFd < 0) return {};
    struct stat fileInfo {};
    if (::fstat (fileFd, &fileInfo) != 0 || ! S_ISREG (fileInfo.st_mode) ||
        fileInfo.st_uid != ::geteuid() || (fileInfo.st_mode & 0077) != 0 ||
        fileInfo.st_size < 2 || fileInfo.st_size > 512)
    {
        ::close (fileFd);
        return {};
    }
    std::array<char, 513> bytes {};
    const auto length = ::read (fileFd, bytes.data(), static_cast<size_t> (fileInfo.st_size));
    ::close (fileFd);
    if (length != fileInfo.st_size) return {};
    return parseBrokerDescriptor (juce::String::fromUTF8 (bytes.data(), static_cast<int> (length)));
}

inline bool isLaunchUrlFor (const juce::String& text, const BrokerDescriptor& descriptor)
{
    const juce::URL url (text);
    const auto& names = url.getParameterNames();
    const auto& values = url.getParameterValues();
    return url.getScheme() == "http" && url.getDomain() == "127.0.0.1" &&
        url.getPort() == descriptor.port &&
        (url.getSubPath() == "/chat" || url.getSubPath() == "chat") &&
        names.size() == 1 && values.size() == 1 && names[0] == "launch" &&
        isUuid (values[0]) && ! text.containsChar ('#') && ! text.containsChar ('@');
}

inline juce::String requestLaunchTicket (const BrokerDescriptor& descriptor)
{
    const auto endpoint = "http://127.0.0.1:" + juce::String (descriptor.port) + "/vst3/tickets";
    const auto headers = "Authorization: Bearer " + descriptor.capability + "\r\nContent-Length: 0\r\n";
    int status = 0;
    auto stream = juce::URL (endpoint).createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withHttpRequestCmd ("POST")
            .withExtraHeaders (headers)
            .withConnectionTimeoutMs (1500)
            .withNumRedirectsToFollow (0)
            .withStatusCode (&status));
    if (stream == nullptr || status != 200) return {};
    std::array<char, 513> bytes {};
    const auto length = stream->read (bytes.data(), static_cast<int> (bytes.size()));
    if (length <= 0 || length > 512) return {};
    const auto value = juce::JSON::parse (juce::String::fromUTF8 (bytes.data(), length));
    const auto* object = value.getDynamicObject();
    if (object == nullptr || object->getProperties().size() != 2 ||
        object->getProperty ("bridgeId").toString() != descriptor.bridgeId) return {};
    const auto url = object->getProperty ("launchUrl").toString();
    return isLaunchUrlFor (url, descriptor) ? url : juce::String {};
}
}
