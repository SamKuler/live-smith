import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { MAX_SKILL_FILE_BYTES } from "../skills/format.js";
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
} from "./skills.js";
import { StorageCommitOutcomeUnknownError } from "./persistence.js";

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
  assert.deepEqual(await fs.readFile(definitionPath(directory, installed.id)), source);
  assert.deepEqual(await listInstalledSkills(directory), [installed]);
  assert.deepEqual(await readInstalledSkill(directory, installed.id), {
    id: installed.id,
    description: installed.description,
    body: `# ${installed.id}\n\nUse existing Live Smith tools carefully.\n`,
  });

  if (process.platform !== "win32") {
    assert.equal(
      (await fs.stat(path.join(directory, "live-smith-skills"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await fs.stat(path.dirname(definitionPath(directory, installed.id)))).mode & 0o777,
      0o700,
    );
    assert.equal((await fs.stat(catalogPath(directory))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(definitionPath(directory, installed.id))).mode & 0o777, 0o600);
  }
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
  assert.deepEqual(await fs.readFile(definitionPath(directory, original.id)), skillBytes("mixing-review"));

  const replacement = await installSkill(directory, replacementBytes, { replace: true });
  assert.equal(replacement.installedAt, original.installedAt);
  assert.ok(replacement.updatedAt >= original.updatedAt);
  assert.notEqual(replacement.sha256, original.sha256);
  assert.deepEqual(await fs.readFile(definitionPath(directory, original.id)), replacementBytes);
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
    await fs.readdir(path.dirname(definitionPath(directory, "bounded-review"))),
    ["SKILL.md"],
  );
});

test("same-byte replacement retries are idempotent after verifying stored bytes", async () => {
  const directory = await temporaryDirectory();
  const source = skillBytes("retry-review");
  const original = await installSkill(directory, source);
  const catalogBefore = await fs.readFile(catalogPath(directory));

  const retried = await installSkill(directory, source, { replace: true });

  assert.deepEqual(retried, original);
  assert.deepEqual(await fs.readFile(catalogPath(directory)), catalogBefore);
  assert.deepEqual(
    await fs.readdir(path.dirname(definitionPath(directory, "retry-review"))),
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
    await fs.writeFile(target, original);
    await assert.rejects(
      listInstalledSkills(directory),
      (error: unknown) => error instanceof SkillStorageCorruptionError,
    );
    assert.deepEqual(await fs.readFile(target), original);
  }
});

test("skill catalog rejects missing, replaced, and symlinked definitions", async (context) => {
  const missingDirectory = await temporaryDirectory();
  await installSkill(missingDirectory, skillBytes("missing-review"));
  await fs.unlink(definitionPath(missingDirectory, "missing-review"));
  await assert.rejects(
    listInstalledSkills(missingDirectory),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );

  const mismatchDirectory = await temporaryDirectory();
  await installSkill(mismatchDirectory, skillBytes("mismatch-review"));
  const mismatchTarget = definitionPath(mismatchDirectory, "mismatch-review");
  const original = await fs.readFile(mismatchTarget);
  await fs.writeFile(mismatchTarget, Buffer.alloc(original.byteLength, 0x78));
  assert.deepEqual(
    (await listInstalledSkills(mismatchDirectory)).map((entry) => entry.id),
    ["mismatch-review"],
  );
  await assert.rejects(
    readInstalledSkill(mismatchDirectory, "mismatch-review"),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );

  if (process.platform === "win32") {
    context.skip("symlink permission behavior is platform-specific");
    return;
  }
  const symlinkDirectory = await temporaryDirectory();
  await installSkill(symlinkDirectory, skillBytes("symlink-review"));
  const external = path.join(symlinkDirectory, "external.md");
  await fs.writeFile(external, skillBytes("symlink-review"));
  const target = definitionPath(symlinkDirectory, "symlink-review");
  await fs.unlink(target);
  await fs.symlink(external, target);
  await assert.rejects(
    listInstalledSkills(symlinkDirectory),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );
});

test("skill catalog tightens overly broad persisted permissions on read", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permissions are unavailable");
    return;
  }
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("private-review"));
  const root = path.join(directory, "live-smith-skills");
  const skillDirectory = path.join(root, "private-review");
  await fs.chmod(root, 0o777);
  await fs.chmod(skillDirectory, 0o755);
  await fs.chmod(catalogPath(directory), 0o644);
  await fs.chmod(definitionPath(directory, "private-review"), 0o666);

  await listInstalledSkills(directory);
  await readInstalledSkill(directory, "private-review");

  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(skillDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(catalogPath(directory))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(definitionPath(directory, "private-review"))).mode & 0o777, 0o600);
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

test("installed skill deletion removes its private directory and is idempotently absent", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("delete-review"));

  await deleteInstalledSkill(directory, "delete-review");

  assert.deepEqual(await listInstalledSkills(directory), []);
  await assert.rejects(fs.stat(path.dirname(definitionPath(directory, "delete-review"))), {
    code: "ENOENT",
  });
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

test("definition replacement rejects a swapped parent directory before any external write", async (context) => {
  if (process.platform === "win32") {
    context.skip("directory symlink race setup is POSIX-specific");
    return;
  }
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("parent-race"));
  const root = path.join(directory, "live-smith-skills");
  const skillDirectory = path.join(root, "parent-race");
  const displaced = path.join(root, "parent-race-displaced");
  const externalDirectory = path.join(directory, "external-target");
  const externalDefinition = path.join(externalDirectory, "SKILL.md");
  const externalBytes = Buffer.from("external bytes must remain unchanged");
  await fs.mkdir(externalDirectory);
  await fs.writeFile(externalDefinition, externalBytes);
  let swapped = false;

  await assert.rejects(
    withSkillCatalogTransaction(
      directory,
      (catalog) => catalog.installSkill(
        skillBytes("parent-race", "# Replacement\n\nDo not redirect this.\n"),
        { replace: true },
      ),
      {
        fault: async (point) => {
          if (swapped || point !== "before-definition-replace") return;
          swapped = true;
          await fs.rename(skillDirectory, displaced);
          await fs.symlink(externalDirectory, skillDirectory);
        },
      },
    ),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );

  assert.deepEqual(await fs.readFile(externalDefinition), externalBytes);
  assert.equal(
    (await fs.readFile(path.join(displaced, "SKILL.md"), "utf8"))
      .includes("Do not redirect this"),
    false,
  );
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

  assert.deepEqual(await fs.readdir(path.join(directory, "live-smith-skills")), [
    "catalog.json",
  ]);
});

test("stable opens remove only regular internal catalog temporaries", async () => {
  const directory = await temporaryDirectory();
  await installSkill(directory, skillBytes("catalog-temp-review"));
  const root = path.join(directory, "live-smith-skills");
  const stale = path.join(root, ".catalog.json.tmp_stale-safe-id");
  await fs.writeFile(stale, "stale", { mode: 0o600 });

  await listInstalledSkills(directory);
  await assert.rejects(fs.stat(stale), { code: "ENOENT" });

  if (process.platform !== "win32") {
    const external = path.join(directory, "external-temp");
    await fs.writeFile(external, "external");
    await fs.symlink(external, stale);
    await assert.rejects(
      listInstalledSkills(directory),
      (error: unknown) => error instanceof SkillStorageCorruptionError,
    );
    assert.equal(await fs.readFile(external, "utf8"), "external");
  }
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

test("skill file reads reject lstat-open replacement and post-fstat growth", async () => {
  const replacementDirectory = await temporaryDirectory();
  const source = skillBytes("race-review");
  await installSkill(replacementDirectory, source);
  const target = definitionPath(replacementDirectory, "race-review");
  let replaced = false;

  await assert.rejects(
    withSkillCatalogTransaction(
      replacementDirectory,
      (catalog) => catalog.listInstalledSkills(),
      {
        fault: async (point) => {
          if (replaced || point !== "after-definition-lstat") return;
          replaced = true;
          const displaced = `${target}.displaced`;
          await fs.rename(target, displaced);
          await fs.writeFile(target, source, { mode: 0o600 });
        },
      },
    ),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );

  const growthDirectory = await temporaryDirectory();
  await installSkill(growthDirectory, skillBytes("growth-review"));
  const growthTarget = definitionPath(growthDirectory, "growth-review");
  let grown = false;
  await assert.rejects(
    withSkillCatalogTransaction(
      growthDirectory,
      (catalog) => catalog.readInstalledSkill("growth-review"),
      {
        fault: async (point) => {
          if (grown || point !== "after-definition-fstat") return;
          grown = true;
          await fs.appendFile(growthTarget, "x");
        },
      },
    ),
    (error: unknown) => error instanceof SkillStorageCorruptionError,
  );
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
      assert.deepEqual(await fs.readFile(definitionPath(directory, "journal-review")), skillBytes("journal-review"));
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
