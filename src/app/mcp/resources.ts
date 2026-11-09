import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/server";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "../../attachments/contracts.js";
import { listSessionAttachments, listPendingSessionAttachments, stageSessionAttachmentStream, sessionAttachmentRefFromStored, sessionAttachmentExport } from "../../storage/attachments.js";
import { sessionAudioArtifactExport } from "../../storage/audio-artifacts.js";
import { readDeviceParameterArtifact } from "../../storage/device-parameter-artifacts.js";
import { isSafeStorageId } from "../../storage/id.js";
import type { McpServerClient } from "../../storage/mcp-server-auth.js";
import { midiArtifactExport } from "../../storage/midi-artifacts.js";
import type { SessionFileExport } from "../../storage/file-export.js";
import { appendSessionEvent, loadConsumedAttachmentIds } from "../../storage/events.js";
import { invalidateSessionState } from "../session/session-state-events.js";
import { openAttachmentBodyStream } from "../chat/chat-bridge-http.js";
import { attachmentMutationFence } from "../session/session-fences.js";
import { sessionMutationFenceKey } from "../session/session-mutation-fence.js";
import { readSessionArtifactCatalog } from "../session/session-artifacts.js";
import { requireMcpSession } from "./tool-runtime.js";

export const mcpUploadDescription = { path: "/attachments", method: "POST", contentType: "application/octet-stream",
  fileNameHeader: "X-Live-Smith-Filename", fileNameEncoding: "encodeURIComponent", maximumBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
  audioSource: { kind: "session_audio_attachment", attachmentId: "<returned attachment id>" } };
export function mcpResourceUri(sessionId: string, kind: string, id: string): string {
  return `livesmith://sessions/${sessionId}/artifacts/${kind}/${id}`;
}
export async function listMcpResources(directory: string, client: McpServerClient, signal: AbortSignal): Promise<ListResourcesResult> {
  await requireMcpSession(directory, client);
  const catalog = await readSessionArtifactCatalog({ storageDirectory: directory, sessionId: client.sessionId, signal, includeHostMidi: true });
  return { resources: [
    ...catalog.artifacts.map(artifact => ({ uri: mcpResourceUri(client.sessionId, artifact.ref.kind, artifact.ref.id), name: artifact.label,
      mimeType: artifact.ref.kind === "midi" ? "audio/midi" : artifact.ref.kind === "audio" ? artifact.audio!.mediaType : "application/json" })),
    ...(await listSessionAttachments(directory, client.sessionId)).map(attachment => ({ uri: mcpResourceUri(client.sessionId, "attachment", attachment.id), name: attachment.fileName, mimeType: attachment.mediaType })),
  ] };
}
export async function readMcpResourceBytes(directory: string, client: McpServerClient, uri: string, signal: AbortSignal) {
  await requireMcpSession(directory, client);
  const match = /^livesmith:\/\/sessions\/([^/]+)\/artifacts\/(midi|audio|device-parameters|attachment)\/([^/]+)$/u.exec(uri);
  if (!match || match[1] !== client.sessionId || !isSafeStorageId(match[3])) throw new Error("Resource is unavailable in this Session.");
  const id = match[3];
  // Inline resources use the same verified export boundary as downloads.
  if (match[2] === "midi" || match[2] === "audio" || match[2] === "attachment") {
    const file = match[2] === "midi" ? await midiArtifactExport(directory, client.sessionId, id)
      : match[2] === "audio" ? await sessionAudioArtifactExport(directory, client.sessionId, id)
      : await sessionAttachmentExport(directory, client.sessionId, id);
    if (file.byteLength > 512 * 1024) throw new Error("Resource exceeds the inline response limit.");
    const stream = await file.open(signal);
    const parts: Buffer[] = [];
    let length = 0;
    try {
      for await (const part of stream) {
        const bytes = Buffer.from(part as Uint8Array);
        length += bytes.length;
        if (length > file.byteLength || length > 512 * 1024) throw new Error("Resource exceeds the inline response limit.");
        parts.push(bytes);
      }
      if (length !== file.byteLength) throw new Error("Resource content is incomplete.");
    } finally { stream.destroy(); }
    return { bytes: Buffer.concat(parts, length), mimeType: file.mediaType, name: file.fileName };
  }
  switch (match[2]) {
    default: { const artifact = await readDeviceParameterArtifact(directory, client.sessionId, id);
      const { parameters, ...metadata } = artifact;
      // Runtime handles are private host bindings; exported snapshots keep musical values.
      const bytes = Buffer.from(JSON.stringify({ ...metadata, target: { trackName: artifact.target.trackName, deviceName: artifact.target.deviceName },
        parameters: parameters.map(({ handleId: _handleId, ...parameter }) => parameter) }));
      return { bytes, mimeType: "application/json", name: artifact.label }; }
  }
}
export async function readMcpResource(directory: string, client: McpServerClient, uri: string, baseUrl: string, signal: AbortSignal): Promise<ReadResourceResult> {
  const file = await mcpResourceExport(directory, client, uri, signal);
  if (file.byteLength <= 512 * 1024) {
    const { bytes, mimeType } = await readMcpResourceBytes(directory, client, uri, signal);
    return { contents: [{ uri, mimeType, blob: Buffer.from(bytes).toString("base64") }] };
  }
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ name: file.fileName, mimeType: file.mediaType, byteLength: file.byteLength,
    downloadUrl: `${baseUrl}/resources?uri=${encodeURIComponent(uri)}`, authorization: "Use the same Bearer credential as the MCP connection." }) }] };
}

async function mcpResourceExport(directory: string, client: McpServerClient, uri: string, signal: AbortSignal): Promise<SessionFileExport> {
  await requireMcpSession(directory, client);
  const match = /^livesmith:\/\/sessions\/([^/]+)\/artifacts\/(midi|audio|device-parameters|attachment)\/([^/]+)$/u.exec(uri);
  if (!match || match[1] !== client.sessionId || !isSafeStorageId(match[3])) throw new Error("Resource is unavailable in this Session.");
  const id = match[3];
  if (match[2] === "midi") return midiArtifactExport(directory, client.sessionId, id);
  if (match[2] === "audio") return sessionAudioArtifactExport(directory, client.sessionId, id);
  if (match[2] === "attachment") return sessionAttachmentExport(directory, client.sessionId, id);
  const { bytes, mimeType, name } = await readMcpResourceBytes(directory, client, uri, signal);
  return { fileName: name, mediaType: mimeType, byteLength: bytes.byteLength, open: async () => Readable.from([bytes]) };
}
export async function handleMcpFileRequest(directory: string, client: McpServerClient, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/attachments" && url.pathname !== "/resources") return false;
  try {
    await requireMcpSession(directory, client);
    if (url.pathname === "/attachments") {
      if (request.method !== "POST" || url.search) { response.writeHead(405); response.end(); return true; }
      const encoded = request.headers["x-live-smith-filename"];
      if (typeof encoded !== "string") throw new Error("Provide X-Live-Smith-Filename.");
      const fileName = decodeURIComponent(encoded);
      const body = await openAttachmentBodyStream(request, signal);
      let saved;
      let staged: Awaited<ReturnType<typeof stageSessionAttachmentStream>> | undefined;
      try {
        staged = await stageSessionAttachmentStream(directory,client.sessionId,{fileName,chunks:body.chunks,signal,
          ...(body.expectedByteLength === undefined ? {} : {expectedByteLength:body.expectedByteLength})});
        saved = await attachmentMutationFence.run(sessionMutationFenceKey(directory, client.sessionId), signal, async () => {
          await requireMcpSession(directory, client);
          const pending = await listPendingSessionAttachments(directory,client.sessionId,await loadConsumedAttachmentIds(directory,client.sessionId));
          const attachment = await staged!.publish({preSavePendingAttachmentRefs:pending.map(sessionAttachmentRefFromStored)});
          await appendSessionEvent(directory, client.sessionId, { kind: "operation", content: "External file uploaded", operation: {
            id: randomUUID(), actor: { kind: "mcp", clientId: client.id, clientName: client.name }, toolName: "upload_attachment", status: "completed", progress: fileName,
            result: { content: JSON.stringify({ attachment: sessionAttachmentRefFromStored(attachment), resource: mcpResourceUri(client.sessionId, "attachment", attachment.id) }),
              failed: false, inputAttachmentIds: [attachment.id] },
          } });
          invalidateSessionState(directory, { sessionId: client.sessionId, source: Symbol("mcp-upload") });
          return attachment;
      }); } finally { await staged?.dispose(); body.close(); }
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ attachment: sessionAttachmentRefFromStored(saved), resource: mcpResourceUri(client.sessionId, "attachment", saved.id) }));
    } else {
      if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "uri") || url.searchParams.getAll("uri").length !== 1) { response.writeHead(400); response.end(); return true; }
      const resource = await mcpResourceExport(directory, client, url.searchParams.get("uri")!, signal);
      const stream = await resource.open(signal);
      try {
        await requireMcpSession(directory, client);
        response.writeHead(200, { "Content-Type": resource.mediaType, "Content-Length": resource.byteLength, "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resource.fileName)}` });
        await pipeline(stream, response, { signal });
      } finally { stream.destroy(); }
    }
  } catch {
    if (response.headersSent) response.destroy();
    else { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "The Session file request could not be completed. Check the reference, file format and upload limits." })); }
  }
  return true;
}
