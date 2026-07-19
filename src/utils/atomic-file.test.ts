import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { atomicReplaceSync } from "./atomic-file";

test("atomicReplaceSync retries a bounded transient sharing violation", () => {
  const testsRoot = join(process.cwd(), "test-output");
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, "atomic-replace-"));
  const source = join(root, "state.json.tmp");
  const destination = join(root, "state.json");
  try {
    writeFileSync(source, "new");
    writeFileSync(destination, "old");
    let attempts = 0;
    atomicReplaceSync(source, destination, {
      retryDelaysMs: [0, 0],
      rename: (from, to) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        renameSync(from, to);
      },
    });
    assert.equal(attempts, 3);
    assert.equal(readFileSync(destination, "utf8"), "new");
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicReplaceSync propagates non-transient failures without retrying", () => {
  const testsRoot = join(process.cwd(), "test-output");
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, "atomic-replace-"));
  const source = join(root, "state.json.tmp");
  const destination = join(root, "state.json");
  try {
    writeFileSync(source, "new");
    let attempts = 0;
    assert.throws(() => atomicReplaceSync(source, destination, {
      retryDelaysMs: [0, 0],
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error("missing path"), { code: "ENOENT" });
      },
    }), /missing path/);
    assert.equal(attempts, 1);
    assert.equal(existsSync(source), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
