import assert from "node:assert/strict";
import test from "node:test";

import { createStorageId } from "./id.js";

test("createStorageId creates prefixed ids without global crypto", () => {
  const id = createStorageId("session");

  assert.match(id, /^session_/);
});
