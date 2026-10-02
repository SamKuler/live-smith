import { URL } from "node:url";

/** Used when running source files; bundled builds embed the Worker script. */
export const officeParserWorkerUrl = new URL("./office-parser.worker.ts", import.meta.url);
