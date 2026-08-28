import assert from "node:assert/strict";
import test from "node:test";

import { safeRegularFileOpenFlags } from "./safe-file-read.js";

test("safe regular-file reads use every host-supported protection flag", () => {
  assert.equal(safeRegularFileOpenFlags({
    O_RDONLY: 0,
    O_NOFOLLOW: 0x100,
    O_NONBLOCK: 0x200,
  }), 0x300);
  assert.equal(safeRegularFileOpenFlags({ O_RDONLY: 0x20 }), 0x20);
});
