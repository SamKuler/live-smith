import type { AudioProvider } from "../../audio-services/contracts.js";
import type {
  IntegrationConnectionView,
  IntegrationConnectionsView,
} from "../../plugins/integration-connections.js";

export interface AudioConnectionDescriptor {
  pluginId: string;
  provider: AudioProvider;
}

export interface AudioConnectionEditorValue {
  id: string;
  name: string;
  provider: AudioProvider;
  enabled: boolean;
  apiKeyConfigured?: boolean;
  modelId?: string;
  callbackUrl?: string;
}

export interface AudioConnectionDraft {
  connection: AudioConnectionEditorValue;
  baseConnection: AudioConnectionEditorValue | null;
  expectedRevision: string;
  conflict: boolean;
  outcomeUnknown?: boolean;
}

export function connectionForAudioEditor(
  connection: IntegrationConnectionView,
  descriptors: Readonly<Record<string, AudioConnectionDescriptor>>,
): AudioConnectionEditorValue | null {
  const descriptor = connection.pluginId !== undefined && Object.hasOwn(descriptors, connection.pluginId)
    ? descriptors[connection.pluginId] : undefined;
  if (!descriptor || connection.configuration === undefined) return null;
  return {
    id: connection.id,
    name: connection.name,
    provider: descriptor.provider,
    enabled: connection.enabled,
    apiKeyConfigured: connection.configuredSecrets.includes("apiKey"),
    ...(connection.configuration.modelId === undefined ? {} : { modelId: connection.configuration.modelId }),
    ...(connection.configuration.callbackUrl === undefined ? {} : { callbackUrl: connection.configuration.callbackUrl }),
  };
}

function copySnapshot(value: IntegrationConnectionsView): IntegrationConnectionsView {
  return JSON.parse(JSON.stringify(value)) as IntegrationConnectionsView;
}

/** Owns the confirmed public Connection snapshot and local audio drafts. Wire validation precedes admission. */
export function createConnectionState(input: {
  initial?: IntegrationConnectionsView;
  descriptors: Readonly<Record<string, AudioConnectionDescriptor>>;
}) {
  let confirmed = input.initial === undefined ? undefined : copySnapshot(input.initial);
  const drafts = new Map<string, AudioConnectionDraft>();
  const projectAudio = (snapshot: IntegrationConnectionsView | undefined) =>
    (snapshot?.connections ?? []).flatMap((connection) => {
      const editor = connectionForAudioEditor(connection, input.descriptors);
      return editor ? [editor] : [];
    });
  let selectedId: string | null = projectAudio(confirmed)[0]?.id ?? null;

  return {
    drafts,
    get selectedId() { return selectedId; },
    set selectedId(value: string | null) { selectedId = value; },
    get revision() { return confirmed?.revision; },
    get nonAudioCount() { return (confirmed?.connections.length ?? 0) - projectAudio(confirmed).length; },
    snapshot(): IntegrationConnectionsView | undefined {
      return confirmed === undefined ? undefined : copySnapshot(confirmed);
    },
    audioConnections(): AudioConnectionEditorValue[] { return projectAudio(confirmed); },
    savedAudio(id: string | null = selectedId): AudioConnectionEditorValue | null {
      return projectAudio(confirmed).find((connection) => connection.id === id) ?? null;
    },
    adopt(value: IntegrationConnectionsView): {
      mcpOnlyChange: boolean;
      conflictedDraftIds: string[];
    } | null {
      if (confirmed && BigInt(value.revision) <= BigInt(confirmed.revision)) return null;
      const next = copySnapshot(value);
      const nextAudio = projectAudio(next);
      const mcpOnlyChange = Boolean(confirmed && value.lastChangeTouchesAudio === false &&
        JSON.stringify(nextAudio) === JSON.stringify(projectAudio(confirmed)) &&
        BigInt(value.revision) === BigInt(confirmed.revision) + 1n);
      const conflictedDraftIds: string[] = [];
      for (const [id, draft] of drafts) {
        if (mcpOnlyChange) {
          if (!draft.conflict) draft.expectedRevision = next.revision;
        } else if (draft.baseConnection || nextAudio.some((connection) => connection.id === id)) {
          // Presence flags cannot reveal a key-only change to a saved connection.
          draft.conflict = true;
          conflictedDraftIds.push(id);
        } else if (!draft.conflict) {
          draft.expectedRevision = next.revision;
        }
      }
      confirmed = next;
      if (!drafts.has(selectedId ?? "") && !nextAudio.some((connection) => connection.id === selectedId)) {
        selectedId = nextAudio[0]?.id ?? null;
      }
      return { mcpOnlyChange, conflictedDraftIds };
    },
  };
}
