import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runTrustValidate } from "./trust-cli";
import { resolveHssRuntimeIdentity, resolveHssScriptIdentity } from "../hss-dll/hss-dll-adapter";
import {
  HSS_TRUST_SUITE_VERSION,
  cacheHssScript,
  hssTrustProfilePath,
  hssTrustProfileMatches,
  hssTrustProjectIdentity,
  hssTrustStoreRoot,
  readHssTrustProfile,
  saveHssTrustProfile,
} from "./trust-profile";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function tempDir(): string {
  fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), ".tmp", "hss-trust-"));
}

function profile(script: ReturnType<typeof cacheHssScript>, projectRoot: string) {
  return {
    version: 1 as const,
    suiteVersion: HSS_TRUST_SUITE_VERSION,
    validatedAt: new Date(0).toISOString(),
    runtime: {
      dllPath: "dll", dllSha256: hash("dll"), dllVersion: "1",
      helperPath: "helper", helperSha256: hash("helper"), helperVersion: "1", helperProtocolVersion: 1,
      adapterPath: "adapter", adapterSha256: hash("adapter"), adapterVersion: "1", sha256: hash("runtime"),
    },
    script,
    project: hssTrustProjectIdentity(projectRoot),
    target: { targetId: "MCU" },
    probe: { serial: "123", interface: "SWD" as const, speedKhz: 4000 },
    validation: { getCaps: true as const, lifecycle: true as const, decoderSemantics: true as const },
  };
}

test("file script is content-addressed once and later identity ignores source changes", () => {
  const cwd = tempDir();
  const store = `${cwd}-store`;
  try {
    const source = path.join(cwd, "init.jlinkscript");
    fs.writeFileSync(source, "source-v1");
    const cached = cacheHssScript({ mode: "file", path: source }, cwd, store);
    assert.equal(path.relative(cwd, cached.path!).startsWith(".."), true);
    assert.equal(cached.path!.startsWith(store), true);
    assert.equal(path.basename(cached.path!), `${hash("source-v1")}.jlinkscript`);
    assert.equal(fs.readFileSync(cached.path!, "utf8"), "source-v1");
    fs.writeFileSync(source, "source-v2");
    assert.equal(fs.readFileSync(cached.path!, "utf8"), "source-v1");
    fs.writeFileSync(source, "source-v1");
    fs.writeFileSync(cached.path!, "tampered");
    assert.throws(() => cacheHssScript({ mode: "file", path: source }, cwd, store), /does not match its content address/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("Trust Profile is atomic, digest-checked, and exact-tuple matched", () => {
  const cwd = tempDir();
  const store = `${cwd}-store`;
  try {
    const saved = saveHssTrustProfile(profile({ mode: "none" }, cwd), cwd, store);
    assert.equal(hssTrustProfilePath(cwd, store).startsWith(store), true);
    const defaultRelative = path.relative(cwd, hssTrustProfilePath(cwd));
    assert.equal(path.isAbsolute(defaultRelative) || defaultRelative.startsWith(".."), true);
    assert.equal(hssTrustProfilePath(cwd).startsWith(hssTrustStoreRoot()), true);
    assert.throws(() => hssTrustProfilePath(cwd, path.join(cwd, "trust")), /outside the project workspace/);
    assert.deepEqual(readHssTrustProfile(cwd, store), saved);
    assert.equal(hssTrustProfileMatches(saved, { targetId: "MCU", serial: "123", interface: "SWD", speedKhz: 4000 }, { mode: "none" }), true);
    assert.equal(hssTrustProfileMatches(saved, { targetId: "MCU", serial: "changed", interface: "SWD", speedKhz: 4000 }, { mode: "none" }), false);
    assert.equal(hssTrustProfileMatches(saved, { targetId: "MCU", serial: "123", interface: "SWD", speedKhz: 4000 }, { mode: "file", path: "cache", sha256: hash("script") }), false);
    fs.writeFileSync(hssTrustProfilePath(cwd, store), JSON.stringify({ ...saved, suiteVersion: "tampered" }));
    assert.equal(readHssTrustProfile(cwd, store), undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("Windows extended paths cannot alias trust storage into the project", { skip: process.platform !== "win32" }, () => {
  const cwd = tempDir();
  try {
    const extendedInside = `\\\\?\\${path.join(cwd, "trust")}`;
    assert.throws(() => hssTrustProfilePath(cwd, extendedInside), /outside the project workspace/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows junctions cannot alias trust storage into the project", { skip: process.platform !== "win32" }, (t) => {
  const cwd = tempDir();
  const junction = `${cwd}-junction`;
  try {
    try {
      fs.symlinkSync(cwd, junction, "junction");
    } catch (error) {
      t.skip(`junction unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    assert.throws(() => hssTrustProfilePath(cwd, path.join(junction, "trust")), /outside the project workspace/);
  } finally {
    try {
      fs.unlinkSync(junction);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows 8.3 paths cannot alias trust storage into the project", { skip: process.platform !== "win32" }, (t) => {
  const cwd = tempDir();
  const inside = path.join(cwd, "inside-long-store-name");
  try {
    fs.mkdirSync(inside);
    let shortPath: string;
    try {
      shortPath = execFileSync("cmd.exe", ["/d", "/c", `for %I in (${inside}) do @echo %~sI`], { encoding: "utf8" }).trim();
    } catch (error) {
      t.skip(`8.3 lookup unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!shortPath || !path.isAbsolute(shortPath) || !fs.existsSync(shortPath) || shortPath.toLowerCase() === inside.toLowerCase()) {
      t.skip("8.3 short names are unavailable on this volume");
      return;
    }
    assert.throws(() => hssTrustProfilePath(cwd, shortPath), /outside the project workspace/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project namespaces isolate identical scripts and reject copied profiles", () => {
  const first = tempDir();
  const second = tempDir();
  const store = `${first}-store`;
  try {
    const firstSource = path.join(first, "init.jlinkscript");
    const secondSource = path.join(second, "init.jlinkscript");
    fs.writeFileSync(firstSource, "same");
    fs.writeFileSync(secondSource, "same");
    const firstCache = cacheHssScript({ mode: "file", path: firstSource }, first, store);
    const secondCache = cacheHssScript({ mode: "file", path: secondSource }, second, store);
    assert.notEqual(path.dirname(firstCache.path!), path.dirname(secondCache.path!));
    saveHssTrustProfile(profile(firstCache, first), first, store);
    fs.mkdirSync(path.dirname(hssTrustProfilePath(second, store)), { recursive: true });
    fs.copyFileSync(hssTrustProfilePath(first, store), hssTrustProfilePath(second, store));
    assert.equal(readHssTrustProfile(second, store), undefined);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("a persisted file profile reproduces the validation runtime identity after restart", () => {
  const cwd = tempDir();
  const store = `${cwd}-store`;
  const previousStore = process.env.JLINK_MCP_TRUST_STORE_ROOT;
  process.env.JLINK_MCP_TRUST_STORE_ROOT = store;
  try {
    const source = path.join(cwd, "init.jlinkscript");
    const dll = path.join(cwd, "JLink_x64.dll");
    const helper = path.join(cwd, "helper.exe");
    const adapter = path.join(cwd, "adapter.js");
    fs.writeFileSync(source, "init");
    fs.writeFileSync(dll, "dll");
    fs.writeFileSync(helper, "helper");
    fs.writeFileSync(adapter, "adapter");
    const input = { script: { mode: "file" as const, path: source }, device: "MCU", interface: "SWD" as const, speedKhz: 4000, serial: "123" };
    const validatedScript = resolveHssScriptIdentity(input, {}, { cwd, trustValidation: true });
    const discovery = { selectedDllPath: dll, sha256: hash("dll") };
    const versions = { dllVersion: "1", helperVersion: "1", helperProtocolVersion: 1 };
    const validatedRuntime = resolveHssRuntimeIdentity(discovery, {}, { helperPath: helper, adapterPath: adapter, scriptIdentity: validatedScript }, versions, true);
    const saved = saveHssTrustProfile({
      ...profile(validatedScript, cwd),
      runtime: {
        dllPath: dll, dllSha256: validatedRuntime.dllSha256!, dllVersion: validatedRuntime.dllVersion!,
        helperPath: helper, helperSha256: validatedRuntime.helperSha256!, helperVersion: validatedRuntime.helperVersion!, helperProtocolVersion: validatedRuntime.helperProtocolVersion!,
        adapterPath: adapter, adapterSha256: validatedRuntime.adapterSha256!, adapterVersion: validatedRuntime.adapterVersion, sha256: validatedRuntime.sha256!,
      },
      script: validatedScript,
    }, cwd);
    const restartedScript = resolveHssScriptIdentity(input, {}, { cwd });
    const restartedRuntime = resolveHssRuntimeIdentity(discovery, {}, {
      helperPath: helper,
      adapterPath: adapter,
      scriptIdentity: restartedScript,
      validatedRuntimeIdentitySha256: [saved.runtime.sha256],
    }, versions, true);
    assert.equal(restartedScript.approvalSha256, validatedScript.approvalSha256);
    assert.equal(restartedRuntime.sha256, validatedRuntime.sha256);
    assert.equal(restartedRuntime.validated, true);
  } finally {
    if (previousStore === undefined) delete process.env.JLINK_MCP_TRUST_STORE_ROOT;
    else process.env.JLINK_MCP_TRUST_STORE_ROOT = previousStore;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("trust validate saves only after local confirmation", async () => {
  const cwd = tempDir();
  const store = `${cwd}-store`;
  const previousStore = process.env.JLINK_MCP_TRUST_STORE_ROOT;
  process.env.JLINK_MCP_TRUST_STORE_ROOT = store;
  try {
    const args = ["--project", cwd, "--target", "MCU", "--artifact", "firmware.out", "--symbol", "counter", "--script-mode", "none"];
    const output: string[] = [];
    const code = await runTrustValidate(args, {
      validate: async () => profile({ mode: "none" }, cwd),
      confirm: async () => true,
      write: (text) => output.push(text),
    });
    assert.equal(code, 0);
    assert.ok(readHssTrustProfile(cwd));
    assert.equal(fs.existsSync(path.join(cwd, ".jlink-mcp", "trust-profile.json")), false);
    assert.match(output.join(""), /Trust Profile saved/);

    fs.rmSync(hssTrustProfilePath(cwd));
    assert.equal(await runTrustValidate(args, {
      validate: async () => profile({ mode: "none" }, cwd),
      confirm: async () => false,
      write: () => undefined,
    }), 2);
    assert.equal(readHssTrustProfile(cwd), undefined);
  } finally {
    if (previousStore === undefined) delete process.env.JLINK_MCP_TRUST_STORE_ROOT;
    else process.env.JLINK_MCP_TRUST_STORE_ROOT = previousStore;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});
