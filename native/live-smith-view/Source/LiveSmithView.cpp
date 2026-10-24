#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include "PluginState.h"
#include "Vst3Broker.h"
#include <atomic>
#include <functional>
#include <memory>
#include <thread>
#include <juce_gui_extra/juce_gui_extra.h>

namespace
{
constexpr int kEditorWidth = 760;
constexpr int kEditorHeight = 620;
struct TicketRequestState
{
    std::atomic<bool> inFlight { false };
    std::atomic<bool> resultReady { false };
    juce::CriticalSection lock;
    juce::String bridgeId;
    juce::String launchUrl;
};
}

class LiveSmithViewProcessor final : public juce::AudioProcessor
{
public:
    LiveSmithViewProcessor()
        : juce::AudioProcessor (BusesProperties()
                                .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                                .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
    {
    }

    const juce::String getName() const override { return JucePlugin_Name; }

    void prepareToPlay (double, int) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override
    {
        const auto& input = layouts.getMainInputChannelSet();
        const auto& output = layouts.getMainOutputChannelSet();

        return input == output
            && (output == juce::AudioChannelSet::mono()
                || output == juce::AudioChannelSet::stereo()
                || output == juce::AudioChannelSet::disabled());
    }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals noDenormals;

        for (auto ch = getTotalNumInputChannels(); ch < getTotalNumOutputChannels(); ++ch)
            buffer.clear (ch, 0, buffer.getNumSamples());
    }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;

    void getStateInformation (juce::MemoryBlock& destData) override
    {
        liveSmith::writeCredentialFreeState (destData);
    }

    void setStateInformation (const void* data, int size) override
    {
        liveSmith::ignoreLegacyState (data, size);
    }

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiveSmithViewProcessor)
};

class SmithBrowser final : public juce::WebBrowserComponent
{
public:
    std::function<void()> onNetworkError;

    SmithBrowser() : juce::WebBrowserComponent (
        juce::WebBrowserComponent::Options{}.withNativeIntegrationEnabled()) {}

    bool pageLoadHadNetworkError (const juce::String&) override
    {
        if (onNetworkError) onNetworkError();
        return true;
    }
};

class LiveSmithViewEditor final : public juce::AudioProcessorEditor,
                                  private juce::Timer
{
public:
    explicit LiveSmithViewEditor (LiveSmithViewProcessor& owner)
        : juce::AudioProcessorEditor (&owner)
    {
        setName ("Live Smith View");
        setResizable (true, true);
        setResizeLimits (460, 320, 1400, 1100);
        setSize (kEditorWidth, kEditorHeight);

        addAndMakeVisible (browser);

        browser.onNetworkError = [this] { loadedUrl.clear(); };
        loadSmithSurface();
        startTimerHz (1);
    }

    void paint (juce::Graphics& g) override
    {
        g.fillAll (juce::Colour::fromRGB (16, 18, 22));
        g.setColour (juce::Colour::fromRGB (42, 48, 58));
        g.drawRect (getLocalBounds(), 1);
    }

    void resized() override
    {
        browser.setBounds (getLocalBounds());
    }

private:
    void startTicketRequest (const liveSmith::BrokerDescriptor& descriptor)
    {
        if (ticketRequest->inFlight.exchange (true)) return;
        ticketRequest->resultReady = false;
        const auto state = ticketRequest;
        std::thread ([state, descriptor]
        {
            const auto url = liveSmith::requestLaunchTicket (descriptor);
            {
                const juce::ScopedLock lock (state->lock);
                state->bridgeId = descriptor.bridgeId;
                state->launchUrl = url;
            }
            state->resultReady = true;
            state->inFlight = false;
        }).detach();
    }

    void loadSmithSurface()
    {
        const auto descriptor = liveSmith::readBrokerDescriptor();
        if (! descriptor)
        {
            if (loadedUrl.isNotEmpty()) browser.goToURL ("about:blank");
            loadedUrl.clear();
            activeBridgeId.clear();
            return;
        }
        if (activeBridgeId != descriptor->bridgeId)
        {
            if (loadedUrl.isNotEmpty()) browser.goToURL ("about:blank");
            loadedUrl.clear();
            activeBridgeId = descriptor->bridgeId;
        }
        if (loadedUrl.isNotEmpty()) return;
        if (ticketRequest->resultReady.exchange (false))
        {
            juce::String resultBridge;
            juce::String resultUrl;
            {
                const juce::ScopedLock lock (ticketRequest->lock);
                resultBridge = ticketRequest->bridgeId;
                resultUrl = ticketRequest->launchUrl;
            }
            if (resultBridge == descriptor->bridgeId &&
                liveSmith::isLaunchUrlFor (resultUrl, *descriptor))
            {
                loadedUrl = resultUrl;
                browser.goToURL (loadedUrl);
                return;
            }
        }
        startTicketRequest (*descriptor);
    }

    void timerCallback() override
    {
        loadSmithSurface();
    }

    juce::String activeBridgeId;
    juce::String loadedUrl;
    std::shared_ptr<TicketRequestState> ticketRequest = std::make_shared<TicketRequestState>();
    SmithBrowser browser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiveSmithViewEditor)
};

juce::AudioProcessorEditor* LiveSmithViewProcessor::createEditor()
{
    return new LiveSmithViewEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new LiveSmithViewProcessor();
}
