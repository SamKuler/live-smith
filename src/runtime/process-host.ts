import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

import { ensurePrivateDirectory } from "../storage/persistence.js";
import {
  type CodexMetadataFirewall,
  startCodexMetadataFirewall,
} from "./codex-metadata-firewall.js";

export type CodexSpawnImplementation = typeof spawn;

const disabledCodexFeatures = [
  "shell_tool",
  "shell_snapshot",
  "unified_exec",
  "code_mode",
  "code_mode_host",
  "view_image",
  "hooks",
  "auth_elicitation",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "multi_agent",
  "multi_agent_v2",
  "personality",
  "apps",
  "enable_mcp_apps",
  "plugins",
  "goals",
  "request_permissions_tool",
  "executor_capability_discovery",
  "skill_search",
  "skill_mcp_dependency_install",
  "recommended_plugins",
  "workspace_dependencies",
  "in_app_browser",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "memories",
  "in_app_updates",
  "remote_plugin",
  "plugin_sharing",
  "remote_compaction_v2",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "fast_mode",
] as const;

function forcedCodexConfiguration(
  chatgptBaseUrl: string,
): readonly string[] {
  return [
    'cli_auth_credentials_store="file"',
    `chatgpt_base_url="${chatgptBaseUrl}"`,
    'openai_base_url="https://chatgpt.com/backend-api/codex"',
    'web_search="disabled"',
    "notify=[]",
    "tools.experimental_request_user_input.enabled=false",
    "tools.update_plan.enabled=false",
    "project_doc_max_bytes=0",
    "project_root_markers=[]",
    "include_permissions_instructions=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
    "include_environment_context=false",
    "memories.generate_memories=false",
    "memories.use_memories=false",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
    "orchestrator.skills.enabled=false",
    "orchestrator.mcp.enabled=false",
    "mcp_servers={}",
    "model_providers={}",
    'model_provider="openai"',
    'forced_login_method="chatgpt"',
    'history.persistence="none"',
    "analytics.enabled=false",
    "feedback.enabled=false",
    "check_for_update_on_startup=false",
    'otel.exporter="none"',
    'otel.trace_exporter="none"',
    'otel.metrics_exporter="none"',
    "otel.log_user_prompt=false",
  ];
}

const inheritedEnvironmentKeys = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
] as const;

export interface CodexChildProcess {
  stdin: Pick<NodeJS.WritableStream, "write" | "end" | "on">;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(
    event: "error" | "exit" | "close",
    listener: (...args: unknown[]) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
  closeAuxiliaryResources(): Promise<void>;
}

export async function spawnCodexAppServer(
  storageDirectory: string,
  spawnImpl: CodexSpawnImplementation = spawn,
): Promise<CodexChildProcess> {
  let metadataFirewall: CodexMetadataFirewall | undefined;
  try {
    const storageRoot = path.resolve(storageDirectory);
    const codexHome = path.join(storageRoot, "codex-subscription");
    const runtimeWorkspace = path.join(codexHome, "runtime-workspace");
    await ensurePrivateDirectory(storageRoot);
    await ensurePrivateChildDirectory(codexHome);
    await ensurePrivateChildDirectory(runtimeWorkspace);
    await assertNoCodexUserConfig(codexHome);
    await assertPrivateCodexAuthFile(codexHome);
    if ((await fs.readdir(runtimeWorkspace)).length !== 0) {
      throw new Error("runtime workspace is not empty");
    }

    metadataFirewall = await startCodexMetadataFirewall();
    const args = [
      "app-server",
      ...forcedCodexConfiguration(metadataFirewall.chatgptBaseUrl)
        .flatMap((value) => ["--config", value]),
      ...disabledCodexFeatures.flatMap((feature) => ["--disable", feature]),
    ];
    const child = spawnImpl("codex", args, {
      cwd: runtimeWorkspace,
      detached: false,
      env: isolatedEnvironment(codexHome),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGTERM");
      throw new Error("missing process pipes");
    }
    const firewall = metadataFirewall;
    const closeAuxiliaryResources = (): Promise<void> => firewall.close();
    const beginAuxiliaryClose = (): void => {
      void closeAuxiliaryResources().catch(() => undefined);
    };
    child.once("error", beginAuxiliaryClose);
    child.once("exit", beginAuxiliaryClose);
    child.once("close", beginAuxiliaryClose);

    let managedChild!: CodexChildProcess;
    managedChild = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      once(event, listener) {
        child.once(event, listener);
        return managedChild;
      },
      kill: (signal) => child.kill(signal),
      closeAuxiliaryResources,
    };
    return managedChild;
  } catch {
    await metadataFirewall?.close().catch(() => undefined);
    throw new Error("Codex App Server could not be started.");
  }
}

async function ensurePrivateChildDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await fs.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("private runtime path is not a directory");
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function assertNoCodexUserConfig(codexHome: string): Promise<void> {
  try {
    await fs.lstat(path.join(codexHome, "config.toml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("unexpected Codex configuration");
}

async function assertPrivateCodexAuthFile(codexHome: string): Promise<void> {
  const authFile = path.join(codexHome, "auth.json");
  let metadata: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    metadata = await fs.lstat(authFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1
  ) {
    throw new Error("managed credential path is not an isolated file");
  }
  if (process.platform !== "win32") await fs.chmod(authFile, 0o600);
}

function isolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.CODEX_HOME = codexHome;
  return environment;
}
