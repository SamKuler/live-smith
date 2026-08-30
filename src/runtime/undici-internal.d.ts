declare module "undici/lib/web/fetch/index.js" {
  export const fetch: typeof globalThis.fetch;
}

declare module "undici/lib/dispatcher/agent.js" {
  import type { Dispatcher } from "undici";

  const Agent: new () => Dispatcher;
  export default Agent;
}

declare module "undici/lib/dispatcher/proxy-agent.js" {
  import type { Dispatcher } from "undici";

  const ProxyAgent: new (proxyUrl: string) => Dispatcher;
  export default ProxyAgent;
}

declare module "undici/lib/dispatcher/dispatcher.js" {
  const Dispatcher: { prototype: object };
  export default Dispatcher;
}

declare module "undici/lib/api/api-connect.js" {
  const connectDispatcher: (...args: unknown[]) => unknown;
  export default connectDispatcher;
}

declare module "undici/lib/handler/wrap-handler.js" {
  import type { Dispatcher } from "undici";

  type DispatchHandler = Parameters<Dispatcher["dispatch"]>[1];
  const WrapHandler: {
    new (handler: DispatchHandler): DispatchHandler;
    wrap(handler: DispatchHandler): DispatchHandler;
  };
  export default WrapHandler;
}
