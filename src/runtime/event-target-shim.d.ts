declare module "event-target-shim/umd" {
  const shim: { Event: typeof import("event-target-shim", { with: { "resolution-mode": "require" } }).Event };
  export default shim;
}
