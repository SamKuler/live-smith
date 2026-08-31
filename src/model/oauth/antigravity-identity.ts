import { arch, platform } from "node:process";

export const antigravitySetupBaseUrl =
  "https://cloudcode-pa.googleapis.com";
export const antigravityApiBaseUrl =
  "https://daily-cloudcode-pa.googleapis.com";

const antigravityCliVersion = "1.1.22";

export function antigravityUserAgent(): string {
  const osType = platform === "win32" ? "windows" : platform;
  const architecture = arch === "x64" ? "amd64" : arch;
  return `antigravity/cli/${antigravityCliVersion} ` +
    `(aidev_client; os_type=${osType}; arch=${architecture}; ` +
    "auth_method=consumer)";
}

export function antigravityMetadataPlatform(): string {
  switch (`${platform}/${arch}`) {
    case "darwin/x64":
      return "DARWIN_AMD64";
    case "darwin/arm64":
      return "DARWIN_ARM64";
    case "linux/x64":
      return "LINUX_AMD64";
    case "linux/arm64":
      return "LINUX_ARM64";
    case "win32/x64":
      return "WINDOWS_AMD64";
    default:
      return "PLATFORM_UNSPECIFIED";
  }
}
