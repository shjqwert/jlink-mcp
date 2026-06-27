import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRepoTempDir, preflightRepoTemp, repoTempRoot } from "./temp-preflight";

test("repo temp preflight uses repo-local .tmp and verifies read/write/delete", async () => {
  const result = await preflightRepoTemp();
  assert.equal(result.status, "ok");
  assert.equal(result.root, repoTempRoot());
  assert.match(result.root, /[\\\/]\.tmp[\\\/]jlink-mcp$/);
  assert.equal(result.writable, true);
  assert.equal(result.readable, true);
  assert.equal(result.deletable, true);
});

test("createRepoTempDir creates unique writable directories under repo temp root", async () => {
  const directory = await createRepoTempDir("unit-");
  try {
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal(directory.startsWith(repoTempRoot()), true);
    await writeFile(join(directory, "probe.txt"), "ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repo temp preflight returns structured errors", async () => {
  const blocker = join(repoTempRoot(), "not-a-directory");
  await writeFile(blocker, "x");
  try {
    const result = await preflightRepoTemp(blocker);
    assert.equal(result.status, "error");
    assert.equal(result.writable, false);
    assert.equal(result.readable, false);
    assert.equal(result.deletable, false);
    assert.ok(result.error?.message);
  } finally {
    await rm(blocker, { force: true });
  }
});
