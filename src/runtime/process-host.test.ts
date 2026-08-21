import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { URL } from "node:url";

import { spawnCodexAppServer } from "./process-host.js";

const disabledFeatures = [
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

function forcedConfiguration(chatgptBaseUrl: string): readonly string[] {
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

test("Codex process launch is fixed and uses a strict environment allowlist", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-process-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));

  const child = fakeChildProcess();
  const capture: {
    command?: string;
    args?: readonly string[];
    options?: SpawnOptions;
  } = {};
  const spawnImpl = ((
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    return child;
  }) as unknown as typeof spawn;

  const blockedEnvironment = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CHATGPT_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_BASE_URL",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
    "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
    "CODEX_APP_SERVER_LOGIN_ISSUER",
    "CODEX_APP_SERVER_DEV_OPEN_APP_URL",
    "CODEX_CONNECTORS_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "HTTP_PROXY",
    "https_proxy",
    "All_Proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "node_extra_ca_certs",
    "GOOGLE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "LIVE_SMITH_ARBITRARY",
  ] as const;
  const preservedEnvironment = {
    PATH: "/live-smith/test-bin",
    PATHEXT: ".EXE;.CMD",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    SYSTEMROOT: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TMPDIR: "/live-smith/tmpdir",
    TMP: "/live-smith/tmp",
    TEMP: "/live-smith/temp",
    LANG: "en_US.UTF-8",
    LANGUAGE: "en_US:en",
    LC_ALL: "C.UTF-8",
    LC_COLLATE: "C",
    LC_CTYPE: "C.UTF-8",
    LC_MESSAGES: "C",
    LC_MONETARY: "C",
    LC_NUMERIC: "C",
    LC_TIME: "C",
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const key of [
    ...blockedEnvironment,
    ...Object.keys(preservedEnvironment),
  ]) {
    previous.set(key, process.env[key]);
  }
  for (const key of blockedEnvironment) {
    process.env[key] = `forbidden-${key}`;
  }
  for (const [key, value] of Object.entries(preservedEnvironment)) {
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const launchedChild = await spawnCodexAppServer(storageDirectory, spawnImpl);
  t.after(() => child.exit(0, null));
  assert.equal(launchedChild.stdin, child.stdin);
  assert.equal(launchedChild.stdout, child.stdout);
  assert.equal(launchedChild.stderr, child.stderr);
  assert.equal(capture.command, "codex");
  const metadataBaseUrl = metadataBaseUrlFromArgs(capture.args);
  assert.deepEqual(capture.args, [
    "app-server",
    ...forcedConfiguration(metadataBaseUrl).flatMap((value) => ["--config", value]),
    ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
  ]);
  assert.equal(capture.options?.shell, false);
  assert.deepEqual(capture.options?.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(capture.options?.windowsHide, true);

  const codexHome = path.join(storageDirectory, "codex-subscription");
  assert.equal(capture.options?.env?.CODEX_HOME, codexHome);
  assert.equal(capture.options?.cwd, path.join(codexHome, "runtime-workspace"));
  assert.deepEqual(await fs.readdir(capture.options.cwd as string), []);
  for (const key of blockedEnvironment) {
    assert.equal(key in (capture.options?.env ?? {}), false, key);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(capture.options?.env ?? {})
        .filter(([key]) => key !== "CODEX_HOME"),
    ),
    preservedEnvironment,
  );

  const userSettings = await requestMetadata(
    metadataBaseUrl,
    `${new URL(metadataBaseUrl).pathname}wham/settings/user`,
  );
  assert.equal(userSettings.statusCode, 200);
  assert.deepEqual(JSON.parse(userSettings.body), {
    commit_attribution_enabled: false,
  });

  const cloudConfig = await requestMetadata(
    metadataBaseUrl,
    `${new URL(metadataBaseUrl).pathname}wham/config/bundle`,
  );
  assert.equal(cloudConfig.statusCode, 200);
  // This is intentionally a safe empty response, not managed-workspace support.
  assert.deepEqual(JSON.parse(cloudConfig.body), {});

  const guessedPath = await requestMetadata(
    metadataBaseUrl,
    "/backend-api/wham/settings/user",
  );
  assert.equal(guessedPath.statusCode, 404);
  const rejectedMethod = await requestMetadata(
    metadataBaseUrl,
    `${new URL(metadataBaseUrl).pathname}wham/settings/user`,
    "POST",
  );
  assert.equal(rejectedMethod.statusCode, 404);

  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200).end("external metadata");
  });
  await listenLocally(upstream);
  t.after(() => closeServer(upstream));
  const upstreamAddress = upstream.address() as AddressInfo;
  const absoluteTarget = `http://127.0.0.1:${upstreamAddress.port}/secret`;
  const rejectedProxyRequest = await requestMetadata(
    metadataBaseUrl,
    absoluteTarget,
  );
  assert.equal(rejectedProxyRequest.statusCode, 404);
  assert.equal(upstreamRequests, 0);

  const secondChild = fakeChildProcess();
  let secondArgs: readonly string[] | undefined;
  await spawnCodexAppServer(storageDirectory, ((
    _command: string,
    args: readonly string[],
  ) => {
    secondArgs = args;
    return secondChild;
  }) as unknown as typeof spawn);
  t.after(() => secondChild.exit(0, null));
  const secondMetadataBaseUrl = metadataBaseUrlFromArgs(secondArgs);
  assert.notEqual(secondMetadataBaseUrl, metadataBaseUrl);
  secondChild.exit(0, null);
  await assertMetadataUnavailable(secondMetadataBaseUrl);

  child.exit(0, null);
  await assertMetadataUnavailable(metadataBaseUrl);
});

test("process launch failures expose no raw spawn details", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-process-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  let capturedArgs: readonly string[] | undefined;
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    capturedArgs = args;
    throw new Error("secret path /Users/example and sk-test-secret");
  }) as unknown as typeof spawn;

  await assert.rejects(
    spawnCodexAppServer(storageDirectory, spawnImpl),
    (error: unknown) => {
      assert.equal(
        error instanceof Error && error.message,
        "Codex App Server could not be started.",
      );
      return true;
    },
  );
  await assertMetadataUnavailable(metadataBaseUrlFromArgs(capturedArgs));
});

test("Codex process launch rejects symlinked private runtime directories", async (t) => {
  for (const target of ["codex-subscription", "runtime-workspace"] as const) {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-process-"));
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-outside-"));
    t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
    t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));

    const codexHome = path.join(storageDirectory, "codex-subscription");
    if (target === "runtime-workspace") await fs.mkdir(codexHome);
    await fs.symlink(
      outsideDirectory,
      target === "codex-subscription"
        ? codexHome
        : path.join(codexHome, "runtime-workspace"),
      "dir",
    );
    let spawnCalls = 0;
    const spawnImpl = (() => {
      spawnCalls += 1;
      return fakeChildProcess();
    }) as unknown as typeof spawn;

    await assert.rejects(
      spawnCodexAppServer(storageDirectory, spawnImpl),
      /Codex App Server could not be started/,
    );
    assert.equal(spawnCalls, 0, target);
  }
});

test("Codex process launch rejects persistent user configuration", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-process-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const codexHome = path.join(storageDirectory, "codex-subscription");
  await fs.mkdir(codexHome);
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    'notify = ["credential-stealing-command"]\n',
  );
  let spawnCalls = 0;
  const spawnImpl = (() => {
    spawnCalls += 1;
    return fakeChildProcess();
  }) as unknown as typeof spawn;

  await assert.rejects(
    spawnCodexAppServer(storageDirectory, spawnImpl),
    /Codex App Server could not be started/,
  );
  assert.equal(spawnCalls, 0);
});

test("Codex process launch rejects linked managed credential files", async (t) => {
  for (const linkKind of ["symbolic", "hard"] as const) {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-process-"));
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-outside-"));
    t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
    t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));
    const codexHome = path.join(storageDirectory, "codex-subscription");
    await fs.mkdir(codexHome);
    const outsideAuth = path.join(outsideDirectory, "auth.json");
    await fs.writeFile(outsideAuth, '{"sentinel":"normal-codex-auth"}');
    const managedAuth = path.join(codexHome, "auth.json");
    if (linkKind === "symbolic") {
      await fs.symlink(outsideAuth, managedAuth, "file");
    } else {
      await fs.link(outsideAuth, managedAuth);
    }
    let spawnCalls = 0;
    const spawnImpl = (() => {
      spawnCalls += 1;
      return fakeChildProcess();
    }) as unknown as typeof spawn;

    await assert.rejects(
      spawnCodexAppServer(storageDirectory, spawnImpl),
      /Codex App Server could not be started/,
    );
    assert.equal(spawnCalls, 0, linkKind);
    assert.equal(
      await fs.readFile(outsideAuth, "utf8"),
      '{"sentinel":"normal-codex-auth"}',
    );
  }
});

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exited = false;

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exit(null, signal ?? "SIGTERM");
    return true;
  }
}

function fakeChildProcess(): FakeCodexChild {
  return new FakeCodexChild();
}

function metadataBaseUrlFromArgs(args: readonly string[] | undefined): string {
  const configuration = args?.find((argument) =>
    argument.startsWith('chatgpt_base_url="')
  );
  assert.notEqual(configuration, undefined);
  const match = /^chatgpt_base_url="(http:\/\/127\.0\.0\.1:[1-9]\d*\/[0-9a-f]{64}\/backend-api\/)"$/u
    .exec(configuration ?? "");
  assert.notEqual(match, null);
  return match?.[1] ?? "";
}

async function requestMetadata(
  baseUrl: string,
  requestPath: string,
  method = "GET",
): Promise<{ statusCode: number; body: string }> {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: base.hostname,
      port: base.port,
      path: requestPath,
      method,
      headers: { Connection: "close" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.once("end", () => {
        resolve({ statusCode: response.statusCode ?? 0, body });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function assertMetadataUnavailable(baseUrl: string): Promise<void> {
  await assert.rejects(
    requestMetadata(baseUrl, new URL(baseUrl).pathname),
    (error: unknown) => {
      assert.match((error as NodeJS.ErrnoException).code ?? "", /^ECONN/u);
      return true;
    },
  );
}

async function listenLocally(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
