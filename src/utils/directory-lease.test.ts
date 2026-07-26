import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withDirectoryLease } from "./directory-lease";

test("directory lease uses bounded backoff for transient EPERM and publishes when no contender exists", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-file-lease-"));
  const lockPath = path.join(root, "capture.lock");
  const rename = fs.renameSync;
  let publishAttempts = 0;
  context.mock.method(fs, "renameSync", (source: PathLike, destination: PathLike) => {
    if (path.resolve(String(destination)) === path.resolve(lockPath)) {
      publishAttempts += 1;
      if (publishAttempts <= 3) throw Object.assign(new Error("transient publish contention"), { code: "EPERM" });
    }
    return rename(source, destination);
  });
  try {
    const result = await withDirectoryLease(lockPath, async () => "acquired", { timeoutMs: 0 });
    assert.equal(result, "acquired");
    assert.equal(publishAttempts, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory lease propagates a persistent EPERM when no contender exists", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-file-lease-"));
  const lockPath = path.join(root, "capture.lock");
  const rename = fs.renameSync;
  let operationCalled = false;
  let publishAttempts = 0;
  context.mock.method(fs, "renameSync", (source: PathLike, destination: PathLike) => {
    if (path.resolve(String(destination)) === path.resolve(lockPath)) {
      publishAttempts += 1;
      throw Object.assign(new Error("persistent permission failure"), { code: "EPERM" });
    }
    return rename(source, destination);
  });
  try {
    await assert.rejects(
      withDirectoryLease(lockPath, async () => { operationCalled = true; }, { timeoutMs: 0 }),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
    );
    assert.equal(operationCalled, false);
    assert.equal(publishAttempts, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
