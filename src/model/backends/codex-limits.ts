import { MAX_REQUEST_BINARY_ATTACHMENT_BYTES } from "../../attachments/contracts.js";

const mebibyte = 1024 * 1024;
const maximumAttachmentBase64Bytes =
  Math.ceil(MAX_REQUEST_BINARY_ATTACHMENT_BYTES / 3) * 4;

/** Full binary quota after base64, plus bounded transcript/tool headroom. */
export const MAX_CODEX_TURN_START_BYTES =
  maximumAttachmentBase64Bytes + 16 * mebibyte;

/** One complete bounded request echo plus equally bounded server output/metadata. */
export const MAX_CODEX_RPC_LINE_BYTES = 2 * MAX_CODEX_TURN_START_BYTES;
