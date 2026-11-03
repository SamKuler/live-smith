import { readNativeAppCapsule, type NativeAppCapsule } from "./native-app-capsule.js";
export type NativeVerifierCapsule = NativeAppCapsule;
export function readNativeVerifierCapsule(): Promise<NativeVerifierCapsule> {
  return readNativeAppCapsule({ name: "SunoVerification", identifier: "dev.livesmith.suno-verification",
    source: "src/runtime/native/suno-verification.m", plist: "src/runtime/native/Info.plist",
    recipe: "scripts/build-native-verifier.ts", capsule: "src/runtime/native/verifier-capsule.json",
    frameworks: ["Cocoa", "WebKit", "Network"] });
}
