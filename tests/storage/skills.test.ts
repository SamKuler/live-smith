import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { MAX_SKILL_FILE_BYTES } from "../../src/skills/format.js";
import {
  MAX_INSTALLED_SKILLS,
  MAX_INSTALLED_SKILL_BYTES,
  SkillStorageCorruptionError,
  deleteInstalledSkill,
  installSkill,
  listInstalledSkills,
  readInstalledSkill,
  withSkillCatalogTransaction,
  type SkillStorageFaultPoint,
  type SkillCatalogTransaction,
} from "../../src/storage/skills.js";
import { listStoredChildren, readStoredBytes, removeStoredEntry, storedEntry, storedTreeExists, writeStoredBytes } from "../../src/storage/sqlite.js";
import { StorageCommitOutcomeUnknownError } from "../../src/storage/persistence.js";

function skillBytes(
  id: string,
  body = `# ${id}\n\nUse existing Live Smith tools carefully.\n`,
): Uint8Array {
  return Buffer.from([
    "---",
    `name: ${id}`,
    `description: Workflow guidance for ${id}.`,
    "---",
    body,
  ].join("\n"), "utf8");
}

function skillBytesOfSize(id: string, byteLength: number): Uint8Array {
  const prefix = Buffer.from([
    "---",
    `name: ${id}`,
    `description: Workflow guidance for ${id}.`,
    "---",
    "# Guidance",
    "",
  ].join("\n"), "utf8");
  const terminal = Buffer.from("\n", "utf8");
  assert.ok(prefix.byteLength + terminal.byteLength <= byteLength);
  return Buffer.concat([
    prefix,
    Buffer.alloc(byteLength - prefix.byteLength - terminal.byteLength, 0x78),
    terminal,
  ]);
}

function catalogPath(directory: string): string {
  return path.join(directory, "live-smith-skills", "catalog.json");
}

function definitionPath(directory: string, id: string): string {
  return path.join(directory, "live-smith-skills", id, "SKILL.md");
}

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "live-smith-skills-"));
}

test("installed skill first install is private, hashed, ordered, and readable", async () => {
  const directory = await temporaryDirectory();
  const source = skillBytes("mixing-review");

  const installed = await installSkill(directory, source);

  assert.deepEqual(installed, {
    id: "mixing-review",
    description: "Workflow guidance for mixing-review.",
    sha256: createHash("sha256").update(source).digest("hex"),
    byteLength: source.byteLength,
    installedAt: installed.installedAt,
    updatedAt: installed.updatedAt,
  });
  assert.equal(new Date(installed.installedAt).toISOString(), installed.installedAt);
  assert.deepEqual(await readStoredBytes(directory, definitionPath(directory, installed.id)), source);
  assert.deepEqual(await listInstalledSkills(directory), [installed]);
  assert.deepEqual(await readInstalledSkill(directory, installed.id), {
    id: installed.id,
    description: installed.description,
    body: `# ${installed.id}\n\nUse existing Live Smith tools carefully.\n`,
  });

  await assert.rejects(fs.lstat(path.join(directory, "live-smith-skills")), { code: "ENOENT" });

});

test("installed skill replacement is explicit and retains its creation timestamp", async () => {
  const directory = await temporaryDirectory();
  const original = await installSkill(directory, skillBytes("mixing-review"));
  const replacementBytes = skillBytes(
    "mixing-review",
    "# Revised\n\nInspect routing before proposing changes.\n",
  );

  await assert.rejects(
    installSkill(directory, replacementBytes),
    /already installed/i,
  );
  assert.deepEqual(await readStoredBytes(directory, definitionPath(directory, original.id)), skillBytes("mixing-review"));

  const replacement = await installSkill(directory, replacementBytes, { replace: true });
  assert.equal(replacement.installedAt, original.installedAt);
  assert.ok(replacement.updatedAt >= original.updatedAt);
  assert.notEqual(replacement.sha256, original.sha256);
  assert.deepEqual(await readStoredBytes(directory, definitionPath(directory, original.id)), replacementBytes);
});

test("repeated replacements retain only the committed SKILL.md bytes", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("bounded-review"));

  for (let revision = 0; revision < 6; revision += 1) {
    await installSkill(
      directory,
      skillBytes("bounded-review", `# Revision ${revision}\n\nUse bounded guidance.\n`),
      { replace: true },
    );
  }

  assert.deepEqual(
    await listStoredChildren(directory, path.dirname(definitionPath(directory, "bounded-review"))),
    ["SKILL.md"],
  );
});

test("same-byte replacement retries are idempotent after verifying stored bytes", async () => {
  const directory = await temporaryDirectory();
  const source = skillBytes("retry-review");
  const original = await installSkill(directory, source);
  const catalogBefore = await readStoredBytes(directory, catalogPath(directory));

  const retried = await installSkill(directory, source, { replace: true });

  assert.deepEqual(retried, original);
  assert.deepEqual(await readStoredBytes(directory, catalogPath(directory)), catalogBefore);
  assert.deepEqual(
    await listStoredChildren(directory, path.dirname(definitionPath(directory, "retry-review"))),
    ["SKILL.md"],
  );
});

test("skill catalog serializes concurrent installs and lists IDs deterministically", async () => {
  const directory = await temporaryDirectory();
  const ids = ["vocal-review", "arrangement-review", "mixing-review", "routing-review"];

  await Promise.all(ids.map((id) => installSkill(directory, skillBytes(id))));

  assert.deepEqual(
    (await listInstalledSkills(directory)).map((entry) => entry.id),
    [...ids].sort(),
  );
});

test("skill catalog enforces count and total raw-byte budgets", async () => {
  const countDirectory = await temporaryDirectory();
  for (let index = 0; index < MAX_INSTALLED_SKILLS; index += 1) {
    await installSkill(countDirectory, skillBytes(`count-${index}`));
  }
  await assert.rejects(
    installSkill(countDirectory, skillBytes("count-overflow")),
    /installed Skill limit/i,
  );

  const byteDirectory = await temporaryDirectory();
  const perFile = MAX_SKILL_FILE_BYTES;
  assert.equal(MAX_INSTALLED_SKILL_BYTES % perFile, 0);
  for (let index = 0; index < MAX_INSTALLED_SKILL_BYTES / perFile; index += 1) {
    await installSkill(
      byteDirectory,
      skillBytesOfSize(`bytes-${index}`, perFile),
    );
  }
  assert.equal(
    (await listInstalledSkills(byteDirectory))
      .reduce((total, entry) => total + entry.byteLength, 0),
    MAX_INSTALLED_SKILL_BYTES,
  );
  await assert.rejects(
    installSkill(byteDirectory, skillBytes("bytes-overflow")),
    /installed Skill byte limit/i,
  );
});

test("skill catalog metadata corruption fails closed without rewriting bytes", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("mixing-review"));
  const target = catalogPath(directory);

  for (const corrupt of [
    "{not-json",
    JSON.stringify({ schemaVersion: 1, skills: [], unknown: true }),
    JSON.stringify({
      schemaVersion: 1,
      skills: [{
        id: "../escape",
        description: "unsafe",
        sha256: "0".repeat(64),
        byteLength: 1,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }),
  ]) {
    const original = Buffer.from(corrupt, "utf8");
    await writeStoredBytes(directory, target, original);
    await assert.rejects(
      listInstalledSkills(directory),
      (error: unknown) => error instanceof SkillStorageCorruptionError,
    );
    assert.deepEqual(await readStoredBytes(directory, target), original);
  }
});

test("skill catalog rejects missing and replaced stored definitions", async () => {
  const missingDirectory = await temporaryDirectory();
  await installSkill(missingDirectory, skillBytes("missing-review"));
  await removeStoredEntry(missingDirectory, definitionPath(missingDirectory, "missing-review"));
  await assert.rejects(listInstalledSkills(missingDirectory), SkillStorageCorruptionError);

  const mismatchDirectory = await temporaryDirectory();
  await installSkill(mismatchDirectory, skillBytes("mismatch-review"));
  const target = definitionPath(mismatchDirectory, "mismatch-review");
  const original = await readStoredBytes(mismatchDirectory, target);
  await writeStoredBytes(mismatchDirectory, target, Buffer.alloc(original.byteLength, 0x78));
  assert.deepEqual((await listInstalledSkills(mismatchDirectory)).map((skill) => skill.id), ["mismatch-review"]);
  await assert.rejects(readInstalledSkill(mismatchDirectory, "mismatch-review"), SkillStorageCorruptionError);
});

test("skill memory catalog owns bytes and isolates returned values", async () => {
  const id = `memory-${randomUUID()}`;
  const source = skillBytes(id);
  const original = Uint8Array.from(source);
  const pendingInstall = installSkill(undefined, source);
  source.fill(0);
  const installed = await pendingInstall;

  const firstList = await listInstalledSkills(undefined);
  const entry = firstList.find((candidate) => candidate.id === id);
  assert.ok(entry);
  entry.description = "mutated outside storage";

  assert.equal(
    (await listInstalledSkills(undefined)).find((candidate) => candidate.id === id)?.description,
    installed.description,
  );
  assert.equal((await readInstalledSkill(undefined, id)).id, id);
  assert.equal(installed.sha256, createHash("sha256").update(original).digest("hex"));
  await deleteInstalledSkill(undefined, id);
  await assert.rejects(readInstalledSkill(undefined, id), /does not exist/i);
});

test("installed skill deletion removes its stored definitions and is idempotently absent", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("delete-review"));

  await deleteInstalledSkill(directory, "delete-review");

  assert.deepEqual(await listInstalledSkills(directory), []);
  assert.equal(await storedTreeExists(directory, path.dirname(definitionPath(directory, "delete-review"))), false);
  await assert.rejects(deleteInstalledSkill(directory, "delete-review"), /does not exist/i);
});

test("retained skill catalog capabilities expire with their storage transaction", async () => {
  const directory = await temporaryDirectory();
  let retained: SkillCatalogTransaction | undefined;

  await withSkillCatalogTransaction(directory, async (catalog) => {
    retained = catalog;
    assert.deepEqual(await catalog.listInstalledSkills(), []);
  });

  assert.ok(retained);
  const expired = retained;
  await assert.rejects(expired.listInstalledSkills(), /no longer/i);
  await assert.rejects(
    expired.installSkill(skillBytes("escaped-review")),
    /no longer/i,
  );
  assert.deepEqual(await listInstalledSkills(directory), []);
});

test("detached catalog operations settle before the transaction releases", async () => {
  const directory = await temporaryDirectory();
  let releaseInstall = (): void => undefined;
  const installGate = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let reachedInstall = (): void => undefined;
  const installReached = new Promise<void>((resolve) => {
    reachedInstall = resolve;
  });
  let detachedInstall: Promise<unknown> | undefined;
  let retainedDuringDrain: SkillCatalogTransaction | undefined;

  const transaction = withSkillCatalogTransaction(
    directory,
    async (catalog) => {
      retainedDuringDrain = catalog;
      detachedInstall = catalog.installSkill(skillBytes("detached-review"));
    },
    {
      fault: async (point) => {
        if (point !== "before-pending-catalog") return;
        reachedInstall();
        await installGate;
      },
    },
  );
  await installReached;
  assert.ok(retainedDuringDrain);
  await assert.rejects(
    retainedDuringDrain.listInstalledSkills(),
    /no longer accepting operations/i,
  );
  let nextTransactionSettled = false;
  const nextTransaction = listInstalledSkills(directory).then((skills) => {
    nextTransactionSettled = true;
    return skills;
  });
  await Promise.resolve();
  assert.equal(nextTransactionSettled, false);

  releaseInstall();
  await transaction;
  await detachedInstall;
  assert.deepEqual(
    (await nextTransaction).map((entry) => entry.id),
    ["detached-review"],
  );

  let detachedRead: Promise<unknown> | undefined;
  await withSkillCatalogTransaction(directory, async (catalog) => {
    detachedRead = catalog.readInstalledSkill("detached-review");
  });
  assert.equal(
    (await detachedRead as { id: string }).id,
    "detached-review",
  );

  let detachedDelete: Promise<void> | undefined;
  await withSkillCatalogTransaction(directory, async (catalog) => {
    detachedDelete = catalog.deleteInstalledSkill("detached-review");
  });
  await detachedDelete;
  assert.deepEqual(await listInstalledSkills(directory), []);
});

test("Skill replacement leaves a later filesystem symlink and its external target untouched", { skip: process.platform === "win32" }, async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installSkill(directory, skillBytes("parent-race"));
  const external = path.join(directory, "external-target");
  await fs.mkdir(external);
  const marker = path.join(external, "SKILL.md");
  await fs.writeFile(marker, "external bytes");
  await fs.symlink(external, path.join(directory, "live-smith-skills"));
  await installSkill(directory, skillBytes("parent-race", "# Replacement\n"), { replace: true });
  assert.equal((await readInstalledSkill(directory, "parent-race")).body, "# Replacement\n");
  assert.equal(await fs.readFile(marker, "utf8"), "external bytes");
});

test("unknown pre-journal installs leave only bounded staging that the next open removes", async () => {
  const directory = await temporaryDirectory();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      withSkillCatalogTransaction(
        directory,
        (catalog) => catalog.installSkill(skillBytes(`orphan-${attempt}`)),
        {
          fault: (point) => {
            if (point === "before-pending-catalog") {
              throw new StorageCommitOutcomeUnknownError(new Error("injected"));
            }
          },
        },
      ),
    );
    assert.deepEqual(await listInstalledSkills(directory), []);
  }

  assert.deepEqual(await listStoredChildren(directory, path.join(directory, "live-smith-skills")), [
    "catalog.json",
  ]);
});

test("stable opens remove internal temporary records and reject unrelated records", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("catalog-temp-review"));
  const root = path.join(directory, "live-smith-skills");
  const stale = path.join(root, ".catalog.json.tmp_stale-safe-id");
  await writeStoredBytes(directory, stale, Buffer.from("stale"));
  await listInstalledSkills(directory);
  assert.equal(await storedEntry(directory, stale), undefined);
  const unrelated = path.join(root, "unexpected.md");
  await writeStoredBytes(directory, unrelated, Buffer.from("unrelated"));
  await assert.rejects(listInstalledSkills(directory), SkillStorageCorruptionError);
  assert.equal((await readStoredBytes(directory, unrelated)).toString(), "unrelated");
});

test("skill catalog recovers first-install journal faults idempotently", async () => {
  for (const point of [
    "after-pending-catalog",
    "before-definition-replace",
    "after-definition-replace",
    "before-final-catalog",
    "after-final-catalog",
  ] as const) {
    const directory = await temporaryDirectory();
    let injected = false;
    const source = skillBytes("first-journal", `# First install\n\n${point}.\n`);

    await assert.rejects(
      withSkillCatalogTransaction(
        directory,
        (catalog) => catalog.installSkill(source),
        {
          fault: (candidate) => {
            if (injected || candidate !== point) return;
            injected = true;
            throw new StorageCommitOutcomeUnknownError(new Error("injected"));
          },
        },
      ),
    );

    assert.deepEqual(
      (await listInstalledSkills(directory)).map((entry) => entry.id),
      ["first-journal"],
    );
    assert.equal((await readInstalledSkill(directory, "first-journal")).body.includes(point), true);
  }
});

test("Skill reads detect changed or removed definitions after a catalog opens", async () => {
  for (const mutation of ["replace", "remove"] as const) {
    const directory = await temporaryDirectory();
    await installSkill(directory, skillBytes("race-review"));
    await assert.rejects(withSkillCatalogTransaction(directory, async (catalog) => {
      const target = definitionPath(directory, "race-review");
      if (mutation === "remove") await removeStoredEntry(directory, target);
      else await writeStoredBytes(directory, target, skillBytes("race-review", "# Changed\n"));
      await catalog.readInstalledSkill("race-review");
    }), SkillStorageCorruptionError);
  }
});

test("skill catalog recovers install and replacement journal faults idempotently", async () => {
  const cases: Array<{
    point: SkillStorageFaultPoint;
    unknown: boolean;
  }> = [
    { point: "before-pending-catalog", unknown: false },
    { point: "after-pending-catalog", unknown: true },
    { point: "before-definition-replace", unknown: true },
    { point: "after-definition-replace", unknown: true },
    { point: "before-final-catalog", unknown: true },
    { point: "after-final-catalog", unknown: true },
  ];

  for (const { point, unknown } of cases) {
    const directory = await temporaryDirectory();
    const original = await installSkill(directory, skillBytes("journal-review"));
    const replacement = skillBytes(
      "journal-review",
      `# Replacement\n\nFault point: ${point}.\n`,
    );
    let injected = false;

    await assert.rejects(
      withSkillCatalogTransaction(
        directory,
        (catalog) => catalog.installSkill(replacement, { replace: true }),
        {
          fault: (candidate) => {
            if (injected || candidate !== point) return;
            injected = true;
            const cause = new Error("injected storage failure");
            throw unknown
              ? new StorageCommitOutcomeUnknownError(cause)
              : cause;
          },
        },
      ),
      (error: unknown) => {
        assert.doesNotMatch(
          error instanceof Error ? error.message : String(error),
          /Fault point|SKILL\.md|live-smith-skills|Replacement/,
        );
        return true;
      },
    );

    const recovered = await listInstalledSkills(directory);
    assert.equal(recovered.length, 1);
    if (point === "before-pending-catalog") {
      assert.equal(recovered[0]?.sha256, original.sha256);
      assert.deepEqual(await readStoredBytes(directory, definitionPath(directory, "journal-review")), skillBytes("journal-review"));
    } else {
      assert.equal(
        recovered[0]?.sha256,
        createHash("sha256").update(replacement).digest("hex"),
      );
      assert.equal((await readInstalledSkill(directory, "journal-review")).body.includes(point), true);
    }
    assert.deepEqual(await listInstalledSkills(directory), recovered);
  }
});

test("skill catalog recovers delete journal faults without a stable missing definition", async () => {
  for (const point of [
    "after-pending-catalog",
    "before-definition-delete",
    "after-definition-delete",
    "before-final-catalog",
    "after-final-catalog",
  ] as const) {
    const directory = await temporaryDirectory();
    await installSkill(directory, skillBytes("delete-journal"));
    let injected = false;

    await assert.rejects(
      withSkillCatalogTransaction(
        directory,
        (catalog) => catalog.deleteInstalledSkill("delete-journal"),
        {
          fault: (candidate) => {
            if (injected || candidate !== point) return;
            injected = true;
            throw new StorageCommitOutcomeUnknownError(new Error("injected"));
          },
        },
      ),
    );

    assert.deepEqual(await listInstalledSkills(directory), []);
    await assert.rejects(readInstalledSkill(directory, "delete-journal"), /does not exist/i);
    assert.deepEqual(await listInstalledSkills(directory), []);
  }
});


test("failed pre-journal staging leaves healthy Skills readable and permits a later install", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const healthy = await installSkill(directory, skillBytes("healthy"));
  await assert.rejects(withSkillCatalogTransaction(directory,
    (catalog) => catalog.installSkill(skillBytes("incomplete")), {
      fault: (point) => { if (point === "before-pending-catalog") throw new Error("Injected staging failure"); },
    }), /Injected staging failure/);
  assert.equal(await storedTreeExists(directory, path.dirname(definitionPath(directory, "incomplete"))), false);
  assert.deepEqual(await listInstalledSkills(directory), [healthy]);
  await installSkill(directory, skillBytes("incomplete"));
  assert.deepEqual((await listInstalledSkills(directory)).map((skill) => skill.id), ["healthy", "incomplete"]);
});

test("legacy Skill pending mutations recover in the database and preserve their original files", async (t) => {
  for (const kind of ["install", "replace", "delete"] as const) {
    const directory = await temporaryDirectory();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const bytes = skillBytes("legacy-review");
    const replacement = skillBytes("legacy-review", "# Legacy replacement\n");
    const metadata = {
      id: "legacy-review", description: "Workflow guidance for legacy-review.",
      sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
      installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const next = { ...metadata, sha256: createHash("sha256").update(replacement).digest("hex"), byteLength: replacement.byteLength };
    const stagingFile = ".SKILL.md.skill_legacy.next";
    const definition = definitionPath(directory, metadata.id);
    const staging = path.join(path.dirname(definition), stagingFile);
    const original = JSON.stringify({schemaVersion: 1, skills: kind === "install" ? [] : [metadata],
      pendingMutation: kind === "delete" ? { kind, skillId: metadata.id } : {
        kind, skillId: metadata.id, next, stagingFile,
      },
    });
    await fs.mkdir(path.dirname(definition), { recursive: true, mode: 0o700 });
    if (kind !== "delete") await fs.writeFile(staging, replacement, { mode: 0o600 });
    if (kind !== "install") await fs.writeFile(definition, bytes, { mode: 0o600 });
    await fs.writeFile(catalogPath(directory), original, { mode: 0o600 });
    assert.deepEqual(await listInstalledSkills(directory), kind === "delete" ? [] : [next]);
    if (kind !== "delete") {
      assert.equal((await readInstalledSkill(directory, metadata.id)).body, "# Legacy replacement\n");
      await deleteInstalledSkill(directory, metadata.id);
    }
    assert.deepEqual(await listInstalledSkills(directory), []);
    assert.equal(await fs.readFile(catalogPath(directory), "utf8"), original);
    if (kind !== "delete") assert.deepEqual(await fs.readFile(staging), replacement);
    if (kind !== "install") assert.deepEqual(await fs.readFile(definition), bytes);
  }
});


test("relative Skill storage roots share catalog and definitions with their absolute path", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const relative = path.relative(process.cwd(), directory);
  const installed = await installSkill(relative, skillBytes("relative-review"));
  assert.deepEqual(await listInstalledSkills(directory), [installed]);
  assert.equal((await readInstalledSkill(relative, installed.id)).id, installed.id);
  await installSkill(relative, skillBytes(installed.id, "# Replaced\n"), { replace: true });
  assert.equal((await readInstalledSkill(directory, installed.id)).body, "# Replaced\n");
  await deleteInstalledSkill(relative, installed.id);
  assert.deepEqual(await listInstalledSkills(directory), []);
});
