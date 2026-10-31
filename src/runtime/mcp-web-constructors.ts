// The UMD entry scopes its Event declaration in both Node ESM and bundled VMs.
import eventTargetShim from "event-target-shim/umd";
import { Response } from "undici/lib/web/fetch/response.js";
import { Request } from "undici/lib/web/fetch/request.js";
import { Headers } from "undici/lib/web/fetch/headers.js";

// The Node MCP adapter captures HTTP constructors and Event while loading.
// Supply missing constructors without replacing the Extension's Fetch transport.
// Undici initializes the BodyInit converter in Response before Request captures it.
for (const [name, value] of Object.entries({ Request, Response, Headers, Event: eventTargetShim.Event })) {
  if (!Object.hasOwn(globalThis, name)) Object.defineProperty(globalThis, name, { value, configurable: true });
}
