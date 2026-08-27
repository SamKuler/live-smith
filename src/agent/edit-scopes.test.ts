import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEditScopesAllow,
  EDIT_SCOPES,
  EditScopeDeniedError,
  isEditScopes,
  requireEditScopes,
  resolveEditScopes,
} from "./edit-scopes.js";

test("missing historical scopes allow existing workflows but empty scopes remain read-only", () => {
  assert.deepEqual(resolveEditScopes(), EDIT_SCOPES);
  assert.deepEqual(requireEditScopes([]), []);
  assert.doesNotThrow(() => assertEditScopesAllow(["devices", "midi"], resolveEditScopes()));
  assert.throws(() => assertEditScopesAllow(["midi"], []), EditScopeDeniedError);
});

test("scope input rejects unknown, duplicate, malformed and missing explicit values", () => {
  for (const value of [undefined, null, "midi", ["midi", "midi"], ["instruments"], [1], Array(1), {}]) {
    assert.equal(isEditScopes(value), false);
    assert.throws(() => requireEditScopes(value), /Edit scopes/);
  }
  assert.deepEqual(requireEditScopes(["structure", "midi"]), ["midi", "structure"]);
});

test("authorization requires every affected scope and reports only missing permissions", () => {
  assert.throws(
    () => assertEditScopesAllow(["midi", "mixer", "structure"], ["midi"]),
    (error) => error instanceof EditScopeDeniedError &&
      JSON.stringify(error.missingScopes) === JSON.stringify(["mixer", "structure"]),
  );
  assert.doesNotThrow(() => assertEditScopesAllow(["midi"], ["midi"]));
});
