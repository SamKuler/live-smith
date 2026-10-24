import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createVst3DiscoveryPublisher } from "../../src/runtime/vst3-discovery.js";

const broker = {
  bridgeId: "123e4567-e89b-12d3-a456-426614174000",
  capability: "123e4567-e89b-12d3-a456-426614174000123e4567-e89b-12d3-a456-426614174001",
  port: 4620,
};

test("VST3 discovery is private, atomic, and cleared only by its owning bridge", async () => {
  const directory = await mkdtemp(join("/private/tmp", "vst3-discovery-"));
  try {
    assert.equal(createVst3DiscoveryPublisher(join(directory, "wrong"), directory), undefined);
    const publish = createVst3DiscoveryPublisher(directory, directory)!;
    const first = await publish(broker);
    const file = join(directory, "vst3-view", "bridge.json");
    assert.equal((await lstat(file)).mode & 0o077, 0);
    assert.equal((await lstat(join(directory, "vst3-view"))).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, ...broker });
    const second = await publish({ ...broker, bridgeId: "123e4567-e89b-12d3-a456-426614174002" });
    await first.clear();
    assert.equal((await lstat(file)).isFile(), true);
    await second.clear();
    await assert.rejects(lstat(file), { code: "ENOENT" });
    await chmod(join(directory, "vst3-view"), 0o755);
    await assert.rejects(publish(broker), /not private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("VST3 discovery refuses a symlinked private directory", async () => {
  const directory = await mkdtemp(join("/private/tmp", "vst3-symlink-"));
  try {
    await symlink("/private/tmp", join(directory, "vst3-view"));
    await assert.rejects(createVst3DiscoveryPublisher(directory, directory)!(broker), /not private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("VST3 discovery refuses a symlinked or nonprivate descriptor", async () => {
  const directory = await mkdtemp(join("/private/tmp", "vst3-descriptor-"));
  try {
    const privateDirectory = join(directory, "vst3-view");
    const descriptor = join(privateDirectory, "bridge.json");
    await mkdir(privateDirectory, { mode: 0o700 });
    await symlink(join(directory, "unrelated"), descriptor);
    await assert.rejects(createVst3DiscoveryPublisher(directory, directory)!(broker), /not private/);
    await rm(descriptor);
    await writeFile(descriptor, "{}", { mode: 0o644 });
    await assert.rejects(createVst3DiscoveryPublisher(directory, directory)!(broker), /not private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
