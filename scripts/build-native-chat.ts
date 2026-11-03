import { readNativeAppCapsule } from "./native-app-capsule.js";
export function readNativeChatCapsule() {
  return readNativeAppCapsule({ name: "NativeChat", identifier: "dev.livesmith.native-chat",
    source: "src/runtime/native/native-chat.m", plist: "src/runtime/native/NativeChat-Info.plist",
    recipe: "scripts/build-native-chat.ts", capsule: "src/runtime/native/chat-capsule.json", frameworks: ["Cocoa", "WebKit"] });
}
