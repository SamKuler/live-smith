import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { canonicalStorageDirectory } from "./scope.js";

test("canonical storage scope unifies a missing real directory and symlink alias", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "live-smith-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realParent = path.join(root, "real");
  const aliasParent = path.join(root, "alias");
  await mkdir(realParent);
  await symlink(realParent, aliasParent, "dir");

  const realDirectory = path.join(realParent, "missing", "storage");
  const aliasDirectory = path.join(aliasParent, "missing", "storage");
  const realScope = await canonicalStorageDirectory(realDirectory);
  const aliasScope = await canonicalStorageDirectory(aliasDirectory);

  assert.equal(aliasScope, realScope);
  assert.equal(
    realScope,
    path.join(await realpath(realParent), "missing", "storage"),
  );
});

test("canonical storage scope follows a dangling symlink before its target exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "live-smith-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetParent = path.join(root, "target");
  const aliasParent = path.join(root, "alias");
  await symlink(path.basename(targetParent), aliasParent, "dir");

  const aliasScope = await canonicalStorageDirectory(
    path.join(aliasParent, "storage"),
  );
  const targetScopeBeforeCreation = await canonicalStorageDirectory(
    path.join(targetParent, "storage"),
  );
  assert.equal(aliasScope, targetScopeBeforeCreation);

  await mkdir(targetParent);
  const targetScopeAfterCreation = await canonicalStorageDirectory(
    path.join(targetParent, "storage"),
  );
  assert.equal(aliasScope, targetScopeAfterCreation);
});

test("canonical storage scope resolves absolute and chained dangling links", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "live-smith-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const absoluteTarget = path.join(root, "absolute-target");
  const absoluteAlias = path.join(root, "absolute-alias");
  await symlink(absoluteTarget, absoluteAlias, "dir");
  assert.equal(
    await canonicalStorageDirectory(path.join(absoluteAlias, "storage")),
    await canonicalStorageDirectory(path.join(absoluteTarget, "storage")),
  );

  const chainedTarget = path.join(root, "chained-target");
  const innerAlias = path.join(root, "inner-alias");
  const outerAlias = path.join(root, "outer-alias");
  await symlink(path.basename(chainedTarget), innerAlias, "dir");
  await symlink(path.basename(innerAlias), outerAlias, "dir");
  assert.equal(
    await canonicalStorageDirectory(path.join(outerAlias, "nested", "storage")),
    await canonicalStorageDirectory(path.join(chainedTarget, "nested", "storage")),
  );
});

test("canonical storage scope fails closed on loops and non-directory ancestors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "live-smith-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink("loop-b", path.join(root, "loop-a"), "dir");
  await symlink("loop-a", path.join(root, "loop-b"), "dir");
  await assert.rejects(
    canonicalStorageDirectory(path.join(root, "loop-a", "storage")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP",
  );

  await writeFile(path.join(root, "file"), "not a directory");
  await assert.rejects(
    canonicalStorageDirectory(path.join(root, "file", "storage")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
  );
});
