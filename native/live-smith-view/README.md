# Live Smith View VST3

This is the existing JUCE Live Smith View processor and WebView editor. It
passes audio through and reads the Extension-owned private bridge discovery
descriptor at runtime. Each editor requests its own short-lived, single-use
launch ticket from the local bridge. No bridge URL or credential is saved in plug-in state; state from
older proof builds is ignored.

On macOS, obtain JUCE 8 separately, then configure and test without installing
the plug-in:

```sh
cmake -S native/live-smith-view -B /tmp/live-smith-view-build \
  -DLIVE_SMITH_JUCE_SOURCE_DIR=/path/to/JUCE
cmake --build /tmp/live-smith-view-build --target LiveSmithStateTests
ctest --test-dir /tmp/live-smith-view-build --output-on-failure
cmake --build /tmp/live-smith-view-build --target LiveSmithView_VST3
```

The installed Extension publishes discovery when its neutral ChatBridge starts.
The descriptor is private to the macOS user and is never stored in a Live Set.
The ExtensionHost owns the bridge process lifetime; a stale descriptor after an
abnormal exit cannot issue tickets. Native Ableton activation and WebView cookie
behavior still require a host test. No SDK deactivation hook is assumed.

## Extension integration and host validation

The view uses the existing Live Smith dialog frontend and Extension-owned
ChatBridge. Native discovery reads only the installed `sam-kuler.live-smith`
Extension Data identity. The Extension publishes a user-private descriptor,
then each editor exchanges its private capability for a separate 30-second,
one-use launch ticket. The browser receives an HttpOnly bridge cookie; plug-in
state is empty, including after restoration of older URL-bearing state. No
separate server or plug-in-owned Session is created.

The Extension starts the neutral Live Set bridge during `activate()`. Right-click
Track, Clip, and Arrangement actions adopt their context on that bridge when
idle. A connected VST3 view stays in place; if no view is connected, the
ordinary system-browser action remains available. Busy work rejects a context
change. MCP Session and `openSession` remain Extension-owned.

The VST3 uses the original JUCE identity. Do not install it alongside another
build with that identity. Before distribution, validate in Ableton Live with
Developer Mode off: activation without right-click, editor reopen, two and
three editors, separate ticket consumption, cookie reconnect, right-click
context, busy work, Live Set changes, and normal quit/relaunch. Source tests
cannot establish ExtensionHost activation timing, WebView cookie persistence,
or graceful completion of in-flight work on quit. No SDK deactivation hook is
assumed.
