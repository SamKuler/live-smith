import { agentActionJsonSchemas } from "../../agent/action-schema.js";
import { isArtifactLabel } from "../../agent/artifact-contracts.js";
import { isDeviceParameterWrites, sameParameterNumber } from "../../agent/device-parameter-contracts.js";
import type { ModelTool, RuntimeProfile } from "../../model/provider.js";
import { cloneJsonValue } from "../../model/json-clone.js";
import type { Toolset } from "../../plugins/registry.js";
import { captureParameterDevice, parameterDeviceTargets, parameterHandleId } from "../../live/device-parameters.js";
import { resolveDeviceTarget, type DevicePath } from "../../live/device-tree.js";
import { resolveTrackSelector } from "../../live/resolve.js";
import type { LiveTarget } from "../../live/target.js";
import { throwIfAborted } from "../../runtime/host.js";
import { readDeviceParameterArtifact, saveDeviceParameterArtifact } from "../../storage/device-parameter-artifacts.js";
import { isSafeStorageId } from "../../storage/id.js";
import { isStorageCommitOutcomeUnknownError } from "../../storage/persistence.js";
import { parameterArtifactView, requireParameterSession, type ParameterArtifactContext } from "./parameter-artifacts.js";

const properties = agentActionJsonSchemas().find((schema) => (schema.properties as { type: { enum: string[] } }).type.enum[0] === "set_device_parameters")!.properties as Record<string, unknown>;
export const parameterArtifactTools = [{ type: "function", function: {
  name: "capture_device_parameter_artifact",
  description: "Capture every exposed parameter of one observed Live device into an immutable Session artifact. This reads Live and saves values without changing it. Use an observed devicePath to disambiguate same-name or nested devices. The snapshot contains raw values, ranges and labels, not a complete plugin preset or automation state. Returns an exact artifactRef; inspect it to author a variation.",
  parameters: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 120 }, trackName: properties.trackName,
    trackRole: { type: "string", enum: ["return", "main"] }, trackIndex: { type: "integer", minimum: 0 },
    deviceName: properties.deviceName, deviceIndex: properties.deviceIndex, devicePath: properties.devicePath },
    required: ["label", "deviceName"], additionalProperties: false },
} }, { type: "function", function: {
  name: "inspect_device_parameter_artifact",
  description: "Read a saved device parameter version from this Session. Returns exact indexes, names, raw values, ranges and enum labels in pages of 64, with nextOffset. Enum labels do not define numeric mappings. Does not observe or change Live.",
  parameters: { type: "object", properties: { artifactRef: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["artifactRef"], additionalProperties: false },
} }, { type: "function", function: {
  name: "save_device_parameter_artifact",
  description: "Save a candidate device parameter version based on an existing captured snapshot. Supply only changed observed parameter indexes, exact names and raw values; all other saved parameters are preserved. The selected next-chat source is inherited; otherwise revisionOf is required. Saving never changes Live. The user can compare, apply and restore versions from the Artifact card.",
  parameters: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 120 }, revisionOf: { type: "string" }, values: properties.values },
    required: ["label", "values"], additionalProperties: false },
} }] satisfies ModelTool[];

export function createParameterArtifactToolset(input: ParameterArtifactContext & { target: LiveTarget; runtimeProfile: RuntimeProfile; revisionOf?: string }): Toolset {
  return { id: "live-smith.device-parameters", tools: () => parameterArtifactTools,
    async callTool(call) {
      let saving = false;
      try {
        await requireParameterSession(input);
        const raw: unknown = JSON.parse(call.arguments);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Provide device parameter arguments.");
        const args = raw as Record<string, unknown>;
        const only = (keys: string[]) => { if (Object.keys(args).some((key) => !keys.includes(key))) throw new Error("Unexpected device parameter argument."); };
        if (call.name === "inspect_device_parameter_artifact") {
          only(["artifactRef", "offset"]);
          if (!isSafeStorageId(args.artifactRef) || args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) throw new Error("Choose an exact parameter artifact and page.");
          const artifact = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, args.artifactRef);
          const offset = args.offset as number ?? 0;
          if (offset > artifact.parameters.length) throw new Error("Parameter page is out of range.");
          return { content: JSON.stringify({ ...parameterArtifactView(artifact), offset,
            parameters: artifact.parameters.slice(offset, offset + 64).map(({ handleId: _handleId, ...parameter }) => parameter),
            ...(offset + 64 < artifact.parameters.length ? { nextOffset: offset + 64 } : {}) }), progressKey: `${artifact.id}:${offset}` };
        }
        if (!isArtifactLabel(args.label)) throw new Error("Provide a label of at most 120 characters.");
        if (call.name === "capture_device_parameter_artifact") {
          only(["label", "trackName", "trackRole", "trackIndex", "deviceName", "deviceIndex", "devicePath"]);
          if (typeof args.deviceName !== "string" || !args.deviceName.trim() ||
              args.trackName !== undefined && typeof args.trackName !== "string" ||
              args.trackRole !== undefined && args.trackRole !== "main" && args.trackRole !== "return" ||
              args.trackIndex !== undefined && (!Number.isSafeInteger(args.trackIndex) || Number(args.trackIndex) < 0) ||
              args.deviceIndex !== undefined && (!Number.isSafeInteger(args.deviceIndex) || Number(args.deviceIndex) < 0)) throw new Error("Choose an observed device and track.");
          const track = resolveTrackSelector(input.context, {
            ...(args.trackName === undefined ? {} : { trackName: args.trackName as string }),
            ...(args.trackRole === undefined ? {} : { trackRole: args.trackRole as "return" | "main" }),
            ...(args.trackIndex === undefined ? {} : { trackIndex: args.trackIndex as number }),
          }, input.target);
          const device = resolveDeviceTarget(track, input.target, args.deviceName, args.devicePath as DevicePath | undefined, args.deviceIndex as number | undefined).device;
          const target = parameterDeviceTargets(input.context).find((entry) => entry.target.trackId === parameterHandleId(track) && entry.target.deviceId === parameterHandleId(device))!.target;
          const snapshot = await captureParameterDevice(input.context, target, input.signal);
          await requireParameterSession(input); saving = true;
          const artifact = await saveDeviceParameterArtifact(input.storageDirectory, input.sessionId, { ...snapshot, label: args.label, source: { kind: "captured" }, signal: input.signal });
          return { content: JSON.stringify({ artifacts: [parameterArtifactView(artifact)] }), artifacts: [{ kind: "device-parameters", id: artifact.id }] };
        }
        if (call.name !== "save_device_parameter_artifact") throw new Error("Unknown device parameter tool.");
        only(["label", "revisionOf", "values"]);
        if (input.revisionOf && args.revisionOf !== undefined && args.revisionOf !== input.revisionOf) throw new Error("This request is revising the parameter source selected by the user.");
        const sourceId = input.revisionOf ?? args.revisionOf;
        if (!isSafeStorageId(sourceId) || !isDeviceParameterWrites(args.values)) throw new Error("Provide a source parameter artifact and distinct observed parameter values.");
        const source = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, sourceId);
        const parameters = cloneJsonValue(source.parameters);
        let changed = false;
        for (const value of args.values) {
          const parameter = parameters[value.parameterIndex];
          if (!parameter || parameter.name !== value.parameterName || value.value < parameter.min || value.value > parameter.max) throw new Error("A parameter index, name or value does not match the saved snapshot.");
          changed ||= !sameParameterNumber(parameter.value, value.value); parameter.value = value.value;
        }
        if (!changed) throw new Error("The proposed parameter values already match the source version.");
        saving = true;
        const artifact = await saveDeviceParameterArtifact(input.storageDirectory, input.sessionId, { target: source.target, parameters, label: args.label,
          source: { kind: "model", profileId: input.runtimeProfile.profile.id, model: input.runtimeProfile.model.model }, revisionOf: source.id, signal: input.signal });
        return { content: JSON.stringify({ artifacts: [parameterArtifactView(artifact)] }), artifacts: [{ kind: "device-parameters", id: artifact.id }] };
      } catch (error) {
        if (saving) return { content: "Parameter artifact storage could not be confirmed. Check saved artifacts before retrying.", failed: true, stop: true,
          ...(isStorageCommitOutcomeUnknownError(error) ? { outcomeUnknown: true } : {}) };
        throwIfAborted(input.signal);
        return { content: error instanceof Error ? error.message : "Invalid device parameter arguments.", failed: true, invalidArguments: true };
      }
    },
  };
}
