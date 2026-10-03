import { isMcpOAuthConfiguration } from "../../../plugins/mcp/oauth-contract.js";
import type { AudioAsset, AudioJobView } from "../../../audio-services/contracts.js";
import type { SunoAccountView } from "../../../audio-services/suno/suno-session-contracts.js";
import type { AudioParameterPanel, AudioParameterSuggestions } from "../../../plugins/builtins/parameter-panel.js";
import type { IntegrationConnectionsView } from "../../../plugins/integration-connections.js";
import type { StandaloneMcpConfig } from "../../../plugins/mcp/config.js";
import type { PluginParameterPanel } from "../../../plugins/parameter-panel.js";
import { isWireMidiContinuation as validateMidiContinuation } from "./midi-continuation.js";
import type { PluginConfigView } from "../../../plugins/user-config.js";
import type { InstalledPluginView, PluginInstallPreview } from "../../../plugins/view.js";
import type { SessionToolCatalog, SunoModelCatalogView } from "../../chat-state.js";
import {
  WIRE_AUDIO_OUTPUT_LABELS,
  WIRE_MAX_AUDIO_ASSET_BYTES,
  WIRE_MAX_AUDIO_ASSET_DURATION_SECONDS,
  WIRE_MAX_AUDIO_JOB_OUTPUTS,
  WIRE_MAX_AUDIO_JOB_TITLE_CHARACTERS,
  WIRE_MAX_AUDIO_SESSION_JOBS,
  WIRE_MAX_INTEGRATION_CONNECTIONS,
  WIRE_MAX_PLUGIN_ARCHIVE_BYTES,
  WIRE_MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH,
  WIRE_MAX_SESSION_TOOL_CATALOG_ISSUES,
  WIRE_MAX_SESSION_TOOL_CATALOG_TOOLS,
  WIRE_SEPARATION_STEMS,
  audioConnectionDescriptorsByPluginId,
  audioServiceCapabilities,
  isBuiltInAudioPluginId,
  singleOutputAudioOperations,
  sunoStemRoles,
  usesImportedSession,
} from "./contracts.js";
import {
  hasOnlyWireKeys,
  includes,
  isDecimalRevision,
  isFiniteNumber,
  isInteger,
  isSafeInteger,
  isWireArray,
  isWireRecord,
  isWireStorageId,
  isWireUiMessage,
  wireField,
  wireUtf8ByteLength,
} from "./primitives.js";

export function createPluginValidators({ isPluginConfigView, isPluginParameterPanel }: {
  isPluginConfigView(value: unknown): value is PluginConfigView;
  isPluginParameterPanel(value: unknown): value is PluginParameterPanel;
}) {
  const isWireMidiContinuation = (value: unknown, sessionId: unknown) => validateMidiContinuation(value, sessionId, isPluginParameterPanel);
  function isWireAudioModelId(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
  }

  function isAudioServiceCallbackUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) ||
      /[\s\x00-\x1f\x7f\\#]/u.test(value) || /%(?![\da-f]{2})/i.test(value)) return false;
    try {
      if (/[\s\x00-\x1f\x7f\\]/u.test(decodeURI(value))) return false;
      const url = new window.URL(value);
      const authority = value.split("/")[2];
      return includes(["http:", "https:"], url.protocol) && authority !== undefined && authority.length > 0 && !authority.includes("@") &&
        !url.username && !url.password;
    } catch { return false; }
  }

  function isWireAudioCallback(service: Record<string, unknown>): boolean {
    const descriptor = typeof service.provider === "string" ? audioServiceCapabilities[service.provider] : undefined;
    return Object.hasOwn(service, "callbackUrl")
      ? descriptor?.callbackUrl === true && isAudioServiceCallbackUrl(service.callbackUrl)
      : descriptor?.callbackUrl !== true || !service.enabled;
  }

  function isWireIntegrationConnections(value: unknown): value is IntegrationConnectionsView {
    return isWireRecord(value) && hasOnlyWireKeys<NonNullable<IntegrationConnectionsView>>(value, ["connections", "revision", "lastChangeTouchesAudio"]) &&
      isDecimalRevision(value.revision) && isWireArray(value.connections) &&
      (value.lastChangeTouchesAudio === undefined || typeof value.lastChangeTouchesAudio === "boolean") &&
      value.connections.length <= WIRE_MAX_INTEGRATION_CONNECTIONS &&
      value.connections.every((connection) => {
        if (!isWireRecord(connection) || !isWireStorageId(connection.id) || typeof connection.name !== "string" ||
          connection.name !== connection.name.trim() || connection.name.length === 0 ||
          connection.name.length > 120 || /[\x00-\x1f\x7f]/.test(connection.name) ||
          typeof connection.enabled !== "boolean" ||
          (connection.oauth !== undefined && !isMcpOAuthConfiguration(connection.oauth)) ||
          !isWireArray(connection.configuredSecrets) ||
          new Set(connection.configuredSecrets).size !== connection.configuredSecrets.length) return false;
        if (connection.mcp !== undefined) {
          return hasOnlyWireKeys(connection, ["id", "name", "enabled", "mcp", "configuredSecrets",
            "artifactInputApproved", "artifactOutputApproved", "oauth"]) &&
            isWireStandaloneMcpConfig(connection.mcp) &&
            (connection.oauth === undefined || connection.mcp.type === "streamable-http") &&
            typeof connection.artifactInputApproved === "boolean" &&
            typeof connection.artifactOutputApproved === "boolean" &&
            (connection.mcp.type === "stdio" || !connection.artifactInputApproved && !connection.artifactOutputApproved) &&
            connection.configuredSecrets.length <= 64 && connection.configuredSecrets.every((name) =>
              typeof name === "string" && name.length > 0 && name.length <= 256 &&
              (isWireStandaloneMcpConfig(connection.mcp) && connection.mcp.type === "stdio" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/).test(name));
        }
        if (!hasOnlyWireKeys(connection, ["id", "name", "pluginId", "enabled", "configuration", "configuredSecrets", "oauth"]) ||
            typeof connection.pluginId !== "string" ||
            !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(connection.pluginId) ||
            !isWireRecord(connection.configuration)) return false;
        if (!isBuiltInAudioPluginId(connection.pluginId)) {
          return hasOnlyWireKeys(connection.configuration, ["serverId", "pluginDigest"]) &&
            typeof connection.configuration.serverId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(connection.configuration.serverId) &&
            typeof connection.configuration.pluginDigest === "string" && /^[a-f0-9]{64}$/.test(connection.configuration.pluginDigest) &&
            connection.configuredSecrets.length <= 8 &&
            connection.configuredSecrets.every((name) => typeof name === "string" &&
              /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name));
        }
        if (connection.oauth !== undefined || !hasOnlyWireKeys(connection.configuration, ["modelId", "callbackUrl"]) ||
            connection.configuredSecrets.length > 1 ||
            !connection.configuredSecrets.every((name) => name === "apiKey")) return false;
        const descriptor = audioConnectionDescriptorsByPluginId[connection.pluginId]!;
        const configuration = connection.configuration;
        return isWireAudioModelId(configuration.modelId) &&
          (configuration.modelId === undefined || descriptor.modelConfigurable === true) &&
          (Object.hasOwn(configuration, "callbackUrl")
            ? descriptor.callbackUrl === true && isAudioServiceCallbackUrl(configuration.callbackUrl)
            : descriptor.callbackUrl !== true || !connection.enabled) &&
          (!connection.enabled || descriptor.tools.length > 0) &&
          (!connection.enabled || connection.configuredSecrets.includes("apiKey") || usesImportedSession(descriptor));
      }) &&
      new Set(value.connections.map((service) => wireField(service, "id"))).size === value.connections.length &&
      new Set(value.connections.map((service) => String(wireField(service, "name")).toLowerCase())).size === value.connections.length;
  }

  function isWireStandaloneMcpConfig(value: unknown): value is StandaloneMcpConfig {
    if (!isWireRecord(value)) return false;
    const bounded = (text: unknown): text is string => typeof text === "string" && text.length <= 8192 && !text.includes("\0");
    if (value.type === "stdio") return hasOnlyWireKeys<NonNullable<StandaloneMcpConfig>>(value, ["type", "command", "args", "cwd"]) &&
      bounded(value.command) && value.command.length > 0 &&
      isWireArray(value.args) && value.args.length <= 128 && value.args.every(bounded) &&
      (value.cwd === undefined || bounded(value.cwd) && value.cwd.length > 0);
    if (value.type !== "streamable-http" || !hasOnlyWireKeys<NonNullable<StandaloneMcpConfig>>(value, ["type", "url"]) ||
        !bounded(value.url) || /[\s\\#]/.test(value.url)) return false;
    try {
      const url = new window.URL(value.url);
      const authority = value.url.match(/^https?:\/\/([^/\\?#]*)/i)?.[1];
      const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
        /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
      return Boolean(authority && !authority.includes("@") && !url.username && !url.password &&
        (url.protocol === "https:" || url.protocol === "http:" && loopback));
    } catch { return false; }
  }

  function isWireAudioAsset(value: unknown, sessionId: unknown, jobId: unknown): value is AudioAsset {
    if (!isWireRecord(value) || !hasOnlyWireKeys<NonNullable<AudioAsset>>(value, ["id", "sessionId", "jobId", "label", "role",
      "mediaType", "byteLength", "sha256", "durationSeconds", "sampleRate", "channels", "origin"]) ||
      !isWireStorageId(value.id) || value.sessionId !== sessionId || value.jobId !== jobId ||
      typeof value.label !== "string" || value.label.length > 1024 ||
      (typeof value.role !== "string" || !Object.hasOwn(WIRE_AUDIO_OUTPUT_LABELS, value.role)) ||
      !includes(["audio/wav", "audio/mpeg"], value.mediaType) ||
      !isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > WIRE_MAX_AUDIO_ASSET_BYTES ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !isFiniteNumber(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > WIRE_MAX_AUDIO_ASSET_DURATION_SECONDS ||
      !isSafeInteger(value.sampleRate) || value.sampleRate <= 0 ||
      !isSafeInteger(value.channels) || value.channels <= 0) return false;
    const origin = value.origin;
    return isWireRecord(origin) && hasOnlyWireKeys(origin, ["kind", "startBeat", "endBeat", "tempo", "sourceAssetId"]) &&
      includes(["attachment", "arrangement", "asset", "generated"], origin.kind) &&
      (origin.kind !== "generated" || hasOnlyWireKeys(origin, ["kind"])) &&
      ["startBeat", "endBeat", "tempo"].every((key) => origin[key] === undefined || isFiniteNumber(origin[key]) && origin[key] >= 0) &&
      (origin.sourceAssetId === undefined || isWireStorageId(origin.sourceAssetId));
  }

  function isWireSunoAccounts(value: unknown, services: IntegrationConnectionsView | undefined): value is SunoAccountView[] {
    return isWireArray(value) && value.length <= WIRE_MAX_INTEGRATION_CONNECTIONS &&
      value.every((account) => isWireRecord(account) &&
        hasOnlyWireKeys(account, ["serviceId", "status", "accountId", "accountName"]) &&
        isWireStorageId(account.serviceId) &&
        services?.connections.some((connection) => connection.id === account.serviceId &&
          (connection.pluginId ? audioConnectionDescriptorsByPluginId[connection.pluginId]?.provider : undefined) === "suno") &&
        includes(["signed_out", "saved", "signed_in", "expired", "unavailable"], account.status) &&
        (!Object.hasOwn(account, "accountId") || includes(["signed_in", "saved"], account.status) &&
          typeof account.accountId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account.accountId)) &&
        (!Object.hasOwn(account, "accountName") || includes(["signed_in", "saved"], account.status) &&
          typeof account.accountName === "string" && account.accountName.trim().length > 0 &&
          account.accountName.length <= 160 && !/[\x00-\x1f\x7f-\x9f]/.test(account.accountName) &&
          !/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(account.accountName))) &&
      new Set(value.map((account) => wireField(account, "serviceId"))).size === value.length;
  }

  function audioJobOutputLimit(job: Record<string, unknown>): number {
    const descriptor = typeof job.provider === "string" ? audioServiceCapabilities[job.provider] : undefined;
    return job.operation === "extract_music_stems" ? sunoStemRoles.length : singleOutputAudioOperations.has(job.operation) ? 1 : descriptor!.generationOutputCount;
  }

  function isWireRemoteAudioOutputs(job: Record<string, unknown>): boolean {
    if (!Object.hasOwn(job, "remoteOutputs")) return job.status !== "ready";
    const outputs = job.remoteOutputs;
    return job.provider === "suno" && includes(audioServiceCapabilities.suno!.operations, job.operation) &&
      isWireArray(outputs) && outputs.length <= audioJobOutputLimit(job) &&
      (job.status !== "ready" || outputs.length > 0) &&
      outputs.every((output) => isWireRecord(output) && hasOnlyWireKeys(output, ["key", "role"]) &&
        typeof output.key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(output.key) &&
        (job.operation === "extract_music_stems" ? includes(sunoStemRoles, output.role) : job.operation === "upload_music" ? output.role === "uploaded_audio" : job.operation === "generate_sound_sample"
          ? includes(["sound_effect", "sound_effect_alternative"], output.role)
          : output.role === "music" || output.role === "music_alternative" && !singleOutputAudioOperations.has(job.operation))) &&
      new Set(outputs.map((output) => wireField(output, "key"))).size === outputs.length &&
      new Set(outputs.map((output) => wireField(output, "role"))).size === outputs.length;
  }

  function isWireSunoModelCatalog(value: unknown, services: IntegrationConnectionsView | undefined, accounts: SunoAccountView[] | undefined): value is SunoModelCatalogView | null | undefined {
    if (value === undefined || value === null) return true;
    if (!services || !accounts) return false;
    return isWireRecord(value) && hasOnlyWireKeys<NonNullable<SunoModelCatalogView | null | undefined>>(value, ["serviceId", "accountId", "integrationConnectionsRevision", "models"]) &&
      isWireStorageId(value.serviceId) && typeof value.accountId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.accountId) &&
      isDecimalRevision(value.integrationConnectionsRevision) && value.integrationConnectionsRevision === services?.revision &&
      services?.connections.some(connection => connection.id === value.serviceId &&
        (connection.pluginId ? audioConnectionDescriptorsByPluginId[connection.pluginId]?.provider : undefined) === "suno") &&
      accounts?.some(account => account.serviceId === value.serviceId && account.accountId === value.accountId &&
        includes(["signed_in", "saved"], account.status)) &&
      isWireArray(value.models) && value.models.length <= 100 &&
      value.models.every(model => isWireRecord(model) && hasOnlyWireKeys(model, ["id", "name", "canUse", "isDefault"]) &&
        typeof model.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.id) &&
        typeof model.name === "string" && Array.from(model.name).length <= 160 && !/[\x00-\x1f\x7f-\x9f]/.test(model.name) &&
        (model.canUse === undefined || typeof model.canUse === "boolean") &&
        (model.isDefault === undefined || typeof model.isDefault === "boolean")) &&
      new Set(value.models.map(model => wireField(model, "id"))).size === value.models.length;
  }

  function isWireAudioJobs(jobs: unknown, sessionId: unknown): jobs is AudioJobView[] {
    return isWireArray(jobs) && jobs.length <= WIRE_MAX_AUDIO_SESSION_JOBS &&
      new Set(jobs.map((job) => wireField(job, "id"))).size === jobs.length && jobs.every((job) => {
        if (!isWireRecord(job) || typeof job.provider !== "string" ||
          !Object.hasOwn(audioServiceCapabilities, job.provider)) return false;
        const descriptor = audioServiceCapabilities[job.provider];
        if (!descriptor || !isWireArray(job.stems)) return false;
        const stems = job.stems;
        return hasOnlyWireKeys(job, ["id", "provider", "serviceId", "operation", "modelId", "title", "status", "stems", "createdAt", "outputs", "remoteOutputs", "message", "remoteOutcome", "resumable"]) &&
        isWireStorageId(job.id) && isWireStorageId(job.serviceId) &&
        includes(descriptor.operations, job.operation) &&
        isWireAudioModelId(job.modelId) && includes(["preparing", "submitting", "running", "collecting", "ready", "completed", "partial",
          "failed", "interrupted", "unknown", "cancelled"], job.status) &&
        isWireRemoteAudioOutputs(job) &&
        isWireArray(job.stems) && (job.operation === "separate_stems" ? job.stems.length > 0 : job.stems.length === 0) && new Set(job.stems).size === job.stems.length &&
        job.stems.every((stem) => includes(WIRE_SEPARATION_STEMS, stem)) &&
        typeof job.createdAt === "string" && isFiniteNumber(Date.parse(job.createdAt)) &&
        (job.title === undefined || typeof job.title === "string" && Boolean(job.title.trim()) &&
          Array.from(job.title).length <= WIRE_MAX_AUDIO_JOB_TITLE_CHARACTERS && !/[\u0000-\u001f\u007f-\u009f]/u.test(job.title)) &&
        (job.message === undefined || isWireUiMessage(job.message) && wireUtf8ByteLength(JSON.stringify(job.message)) <= 4096) &&
        (job.remoteOutcome === undefined || isWireArray(job.remoteOutputs) &&
          includes(["completed", "partial", "failed", "cancelled"], job.remoteOutcome)) &&
        typeof job.resumable === "boolean" &&
        (!job.resumable || !includes(["completed", "cancelled"], job.status)) &&
        isWireArray(job.outputs) && job.outputs.length <= WIRE_MAX_AUDIO_JOB_OUTPUTS &&
        (job.operation === "separate_stems" || job.outputs.length <= audioJobOutputLimit(job)) &&
        new Set(job.outputs.map((asset) => wireField(asset, "id"))).size === job.outputs.length &&
        new Set(job.outputs.map((asset) => wireField(asset, "role"))).size === job.outputs.length &&
        job.outputs.every((asset) => isWireAudioAsset(asset, sessionId, job.id) &&
          (job.operation === "separate_stems"
            ? (stems.includes(asset.role) || asset.role === "residual") && asset.origin.kind !== "generated"
            : asset.origin.kind === "generated" && (job.operation === "extract_music_stems" ? includes(sunoStemRoles, asset.role) : job.operation === "upload_music" ? asset.role === "uploaded_audio" : job.operation === "generate_sound_sample"
              ? includes(["sound_effect", "sound_effect_alternative"], asset.role)
              : job.operation === "generate_sound_effect" ? asset.role === "sound_effect"
              : asset.role === "music" || asset.role === "music_alternative" && !singleOutputAudioOperations.has(job.operation) && descriptor.generationOutputCount > 1)));
      });
  }

  function isWireInstalledPlugin(value: unknown): value is InstalledPluginView {
    const issues = new Set<unknown>([
      "invalid_skill",
      "invalid_mcp_configuration",
      "invalid_mcp_server",
      "unsupported_mcp_transport",
    ]);
    if (!isWireRecord(value) || !hasOnlyWireKeys<NonNullable<InstalledPluginView>>(value, [
      "id", "sha256", "version", "description", "sourceFormat", "enabled",
      "skillCount", "skills", "mcpServers", "unsupportedComponents", "issues", "userConfig",
    ]) ||
      typeof value.id !== "string" ||
      !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(value.id) ||
      (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) ||
      (value.version !== undefined && (typeof value.version !== "string" || value.version.length > 128)) ||
      (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1024)) ||
      !includes(["agent-plugins-1.0", "codex", "claude"], value.sourceFormat) ||
      typeof value.enabled !== "boolean" ||
      !isInteger(value.skillCount) || value.skillCount < 0 || value.skillCount > 2048 ||
      (value.skills !== undefined && (!isWireArray(value.skills) || value.skills.length !== value.skillCount ||
        !value.skills.every((skill) => isWireRecord(skill) && hasOnlyWireKeys(skill, ["id", "description"]) &&
          typeof skill.id === "string" && skill.id.startsWith(value.id + ":") &&
          skill.id.length <= String(value.id).length + 65 &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id.slice(String(value.id).length + 1)) &&
          typeof skill.description === "string" && skill.description.trim().length > 0 &&
          [...skill.description].length <= 240) ||
        new Set(value.skills.map((skill) => wireField(skill, "id"))).size !== value.skills.length)) ||
      (value.userConfig !== undefined && !isPluginConfigView(value.userConfig)) ||
      !isWireArray(value.mcpServers) || value.mcpServers.length > 32 ||
      !value.mcpServers.every((server) => isWireRecord(server) &&
        hasOnlyWireKeys(server, ["id", "type", "approved", "artifactInputApproved", "artifactOutputApproved", "target", "args", "cwd", "envNames", "credentialFields", "oauth"]) &&
        typeof server.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(server.id) &&
        includes(["stdio", "streamable-http"], server.type) &&
        (server.oauth === undefined || server.type === "streamable-http" && isMcpOAuthConfiguration(server.oauth)) &&
        typeof server.approved === "boolean" &&
        typeof server.artifactInputApproved === "boolean" &&
        typeof server.artifactOutputApproved === "boolean" &&
        (!server.artifactInputApproved && !server.artifactOutputApproved ||
          server.type === "stdio" && server.approved) &&
        typeof server.target === "string" && server.target.length > 0 &&
        (server.type === "stdio"
          ? server.target.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(server.target) &&
            isWireArray(server.args) && server.args.length <= 128 &&
            server.args.every((arg) => typeof arg === "string" && arg.length <= 8192 && !arg.includes("\0")) &&
            (server.cwd === undefined || typeof server.cwd === "string" && server.cwd.length > 0 &&
              server.cwd.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(server.cwd)) &&
            isWireArray(server.envNames) && server.envNames.length <= 64 &&
            new Set(server.envNames).size === server.envNames.length &&
            server.envNames.every((name) => typeof name === "string" && name.length > 0 &&
              name.length <= 256 && !name.includes("\0") && !name.includes("="))
          : server.target.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(server.target) &&
            server.args === undefined && server.cwd === undefined && server.envNames === undefined) &&
        isWireArray(server.credentialFields) && server.credentialFields.length <= 64 &&
        new Set(server.credentialFields.map((field) => wireField(field, "name"))).size === server.credentialFields.length &&
        server.credentialFields.every((field) => isWireRecord(field) &&
          hasOnlyWireKeys(field, ["name", "required"]) &&
          typeof field.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) &&
          typeof field.required === "boolean")) ||
      new Set(value.mcpServers.map((server) => wireField(server, "id"))).size !== value.mcpServers.length ||
      !isWireArray(value.unsupportedComponents) || value.unsupportedComponents.length > 32 ||
      new Set(value.unsupportedComponents).size !== value.unsupportedComponents.length ||
      !value.unsupportedComponents.every((entry) => typeof entry === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(entry)) ||
      !isWireArray(value.issues) || value.issues.length > issues.size ||
      new Set(value.issues).size !== value.issues.length ||
      !value.issues.every((entry) => issues.has(entry))) return false;
    return true;
  }

  function isWirePluginInstallPreview(value: unknown): value is PluginInstallPreview {
    if (!isWireRecord(value) || !hasOnlyWireKeys<NonNullable<PluginInstallPreview>>(value, [
      "id", "version", "description", "sourceFormat", "enabled",
      "skillCount", "skills", "mcpServers", "unsupportedComponents", "issues", "userConfig", "sha256", "byteLength",
    ]) ||
      (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) ||
      !isSafeInteger(value.byteLength) || value.byteLength < 1 ||
      value.byteLength > WIRE_MAX_PLUGIN_ARCHIVE_BYTES) return false;
    const installed = { ...value };
    delete installed.byteLength;
    return isWireInstalledPlugin(installed) && installed.enabled === false &&
      installed.mcpServers.every((server) => server.approved === false &&
        server.artifactInputApproved === false && server.artifactOutputApproved === false);
  }

  function isWireAudioParameterSuggestions(value: unknown): value is AudioParameterSuggestions {
    return isWireRecord(value) && Object.entries(value).every(([kind, entries]) =>
      includes(["clips", "models", "personas"], kind) && isWireArray(entries) && entries.length <= 40 &&
      entries.every((entry) => isWireRecord(entry) && hasOnlyWireKeys(entry, ["id", "label"]) &&
        typeof entry.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id) &&
        typeof entry.label === "string" && Array.from(entry.label).length <= 160 && !entry.label.includes("\0")));
  }

  function isWireAudioParameterPanel(value: unknown): value is AudioParameterPanel {
    return isWireRecord(value) && hasOnlyWireKeys<NonNullable<AudioParameterPanel>>(value, ["toolName", "signature", "connectionId", "schema", "suggestions"]) &&
      (value.suggestions === undefined || isWireAudioParameterSuggestions(value.suggestions)) &&
      typeof value.toolName === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.toolName) &&
      typeof value.signature === "string" && /^[a-f0-9]{64}$/.test(value.signature) &&
      (value.connectionId === undefined || isWireStorageId(value.connectionId)) &&
      isWireRecord(value.schema) && wireUtf8ByteLength(JSON.stringify(value.schema)) <= 32 * 1024;
  }

  function isWireSessionToolCatalog(value: unknown, activeSessionId: unknown): value is SessionToolCatalog {
    if (!isWireRecord(value) || !hasOnlyWireKeys<NonNullable<SessionToolCatalog>>(value, [
      "sessionId", "loadedAt", "modelToolsSupported", "truncated", "groups", "issues",
    ]) || value.sessionId !== activeSessionId ||
      typeof value.loadedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.loadedAt) ||
      !isFiniteNumber(Date.parse(value.loadedAt)) ||
      typeof value.modelToolsSupported !== "boolean" ||
      typeof value.truncated !== "boolean" ||
      !isWireArray(value.groups) || value.groups.length > WIRE_MAX_SESSION_TOOL_CATALOG_TOOLS ||
      !isWireArray(value.issues) || value.issues.length > WIRE_MAX_SESSION_TOOL_CATALOG_ISSUES) return false;
    let toolCount = 0;
    for (const group of value.groups) {
      if (!isWireRecord(group) || !hasOnlyWireKeys(group, [
        "kind", "pluginId", "serverId", "connectionId", "connectionName", "tools",
      ]) || !includes(["live", "audio", "mcp"], group.kind) ||
        (group.pluginId !== undefined && (typeof group.pluginId !== "string" ||
          !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(group.pluginId))) ||
        (group.kind === "audio" && group.pluginId === undefined) ||
        (group.kind === "mcp" && (group.pluginId === undefined && group.connectionId === undefined ||
          typeof group.serverId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(group.serverId))) ||
        (group.kind !== "mcp" && group.serverId !== undefined) ||
        (group.kind === "live" && (group.connectionId !== undefined || group.connectionName !== undefined)) ||
        (group.connectionId === undefined) !== (group.connectionName === undefined) ||
        (group.connectionId !== undefined && !isWireStorageId(group.connectionId)) ||
        (group.connectionName !== undefined && (typeof group.connectionName !== "string" ||
          !group.connectionName.trim() || group.connectionName.length > 120 ||
          /[\u0000-\u001f\u007f]/.test(group.connectionName))) ||
        !isWireArray(group.tools) || !group.tools.length) return false;
      toolCount += group.tools.length;
      if (toolCount > WIRE_MAX_SESSION_TOOL_CATALOG_TOOLS || !group.tools.every((tool) =>
        isWireRecord(tool) && hasOnlyWireKeys(tool, ["name", "description", "panel", "app", "audioPanel"]) &&
        (tool.audioPanel === undefined || group.kind === "audio" && isWireAudioParameterPanel(tool.audioPanel) &&
          tool.audioPanel.toolName === tool.name && tool.audioPanel.connectionId === group.connectionId) &&
        (tool.panel === undefined || group.kind === "mcp" && isPluginParameterPanel(tool.panel)) &&
        (tool.app === undefined || group.kind === "mcp" && isWireRecord(tool.app) &&
          hasOnlyWireKeys(tool.app, ["resourceUri", "signature", "toolName"]) &&
          typeof tool.app.resourceUri === "string" && /^ui:\/\/[^\s]{1,2048}$/.test(tool.app.resourceUri) &&
          typeof tool.app.signature === "string" && /^[a-f0-9]{64}$/.test(tool.app.signature) && typeof tool.app.toolName === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(tool.app.toolName)) &&
        typeof tool.name === "string" && tool.name.length > 0 && tool.name.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(tool.name) &&
        typeof tool.description === "string" && tool.description.length > 0 &&
        tool.description.length <= WIRE_MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH && !tool.description.includes("\0"))) return false;
    }
    return value.issues.every((issue) => isWireRecord(issue) &&
      hasOnlyWireKeys(issue, ["pluginId", "connectionId", "serverId", "code", "message"]) &&
      (issue.pluginId !== undefined || issue.connectionId !== undefined) &&
      (issue.pluginId === undefined || typeof issue.pluginId === "string" &&
        /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(issue.pluginId)) &&
      (issue.connectionId === undefined || isWireStorageId(issue.connectionId)) &&
      (issue.serverId === undefined || typeof issue.serverId === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(issue.serverId)) &&
      includes(["invalid_configuration", "unsupported_transport", "approval_required",
        "artifact_permission_required", "authorization_required", "connection_failed", "invalid_tool"], issue.code) &&
      typeof issue.message === "string" && issue.message.length <= WIRE_MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH &&
      !issue.message.includes("\0"));
  }
  return { isWireMidiContinuation, isWireAudioModelId, isAudioServiceCallbackUrl, isWireAudioCallback, isWireIntegrationConnections, isWireStandaloneMcpConfig, isWireAudioAsset, isWireSunoAccounts, audioJobOutputLimit, isWireRemoteAudioOutputs, isWireSunoModelCatalog, isWireAudioJobs, isWireInstalledPlugin, isWirePluginInstallPreview, isWireAudioParameterSuggestions, isWireAudioParameterPanel, isWireSessionToolCatalog };
}
