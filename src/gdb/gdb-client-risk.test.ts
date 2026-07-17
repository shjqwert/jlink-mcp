import assert from "node:assert/strict";
import test from "node:test";
import { GDBClient } from "./gdb-client";

test("raw GDB and gdb load cannot execute without R4 authority", async () => {
  const gdb = new GDBClient("must-not-spawn");
  const raw = await gdb.command("bt");
  assert.equal(raw.success, false);
  assert.equal(raw.code, "approval_required");
  const load = await gdb.command("load", 60_000);
  assert.equal(load.success, false);
  assert.equal(load.code, "approval_required");
});

test("raw GDB rejects R5 script, compound, and unknown verbs before process access", async () => {
  const gdb = new GDBClient("must-not-spawn");
  for (const command of ["source evil.gdb", "bt\nshell calc", "monitor option bytes", "unknown_verb 1"]) {
    const result = await gdb.command(command);
    assert.equal(result.success, false);
    assert.equal(result.code, "r5_forbidden");
  }
  assert.equal((await gdb.loadSymbols("fixture.elf\nsource evil.gdb")).code, "r5_forbidden");
  assert.equal((await gdb.readVariable("value\nshell calc")).code, "r5_forbidden");
});
