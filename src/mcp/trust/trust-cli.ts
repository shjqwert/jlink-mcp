import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ProcessManager } from "../../utils/process-manager";
import { createProbeBackend } from "../../probe/factory";
import {
  discoverHssDll,
  resolveHssHelperPath,
  resolveHssRuntimeIdentity,
  resolveHssScriptIdentity,
  runHssHelperCommand,
  type HssRuntimeIdentity,
} from "../hss-dll/hss-dll-adapter";
import { HssCaptureService } from "../hss/hss-capture-service";
import { readHssMetadata } from "../hss/hss-artifact";
import {
  HSS_TRUST_SUITE_VERSION,
  hssTrustProjectIdentity,
  saveHssTrustProfile,
  type HssScriptSpec,
  type HssTrustProfile,
} from "./trust-profile";

interface TrustValidateInput {
  cwd: string;
  storageRoot: string;
  evidenceRoot: string;
  targetId: string;
  dllPath?: string;
  helperPath?: string;
  adapterPath?: string;
  artifactFile: string;
  mapFile?: string;
  symbol: string;
  script: HssScriptSpec;
  serial?: string;
  interface: "SWD" | "JTAG";
  speedKhz: number;
  rateHz: number;
  durationSec: number;
  userAuthorized: boolean;
}

interface TrustCliDependencies {
  validate?: (input: TrustValidateInput) => Promise<Omit<HssTrustProfile, "profileSha256">>;
  confirm?: (summary: string) => Promise<boolean>;
  write?: (text: string) => void;
}

export async function runTrustValidate(argv: string[], dependencies: TrustCliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((text) => stdout.write(text));
  try {
    const input = parseTrustValidateArgs(argv, dependencies.validate === undefined);
    const profile = await (dependencies.validate ?? validateRuntimeBundle)(input);
    const summary = JSON.stringify({
      suiteVersion: profile.suiteVersion,
      runtime: profile.runtime,
      script: profile.script,
      target: profile.target,
      probe: profile.probe,
      validation: profile.validation,
      paths: { projectRoot: input.cwd, storageRoot: input.storageRoot, evidenceRoot: input.evidenceRoot },
    }, null, 2);
    write(`${summary}\n`);
    const confirmed = input.userAuthorized || await (dependencies.confirm ?? confirmTrust)(summary);
    if (!confirmed) {
      write("Trust Profile not saved.\n");
      return 2;
    }
    const saved = saveHssTrustProfile(profile, input.cwd);
    write(`Trust Profile saved: ${saved.profileSha256}\n`);
    return 0;
  } catch (error) {
    write(`trust validate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function validateRuntimeBundle(input: TrustValidateInput): Promise<Omit<HssTrustProfile, "profileSha256">> {
  const env = process.env;
  const scriptIdentity = resolveHssScriptIdentity({
    script: input.script,
    device: input.targetId,
    interface: input.interface,
    speedKhz: input.speedKhz,
    serial: input.serial,
  }, env, { cwd: input.cwd, trustValidation: true });
  if (!scriptIdentity.validated) throw new Error(scriptIdentity.reason ?? "script identity validation failed");

  const candidate = discoverHssDll({ dllPath: input.dllPath }, env, { adapterPath: input.adapterPath });
  if (!candidate.selectedDllPath || !candidate.sha256 || candidate.architecture !== "x64" || !candidate.exportsFound) {
    throw new Error(candidate.unavailableCode ?? "JLink_x64.dll is not a valid HSS candidate");
  }
  const helperPath = resolveHssHelperPath(env, input.helperPath);
  const helperVersion = await runHssHelperCommand("version", [], { helperPath });
  const helperPreflight = await runHssHelperCommand("preflight", ["--dll", candidate.selectedDllPath], { helperPath });
  if (helperVersion.status !== "ok" || helperPreflight.status !== "ok" || helperPreflight.exportsFound !== true) {
    throw new Error(String(helperPreflight.reason ?? "helper preflight failed"));
  }
  const versions = {
    helperVersion: String(helperVersion.helperVersion ?? ""),
    helperProtocolVersion: Number(helperVersion.helperProtocolVersion ?? 0),
    dllVersion: String(helperPreflight.dllVersion ?? ""),
  };
  const approvedDiscovery = discoverHssDll({ dllPath: candidate.selectedDllPath }, env, { validatedDllSha256: [candidate.sha256], adapterPath: input.adapterPath });
  const provisional = resolveHssRuntimeIdentity(approvedDiscovery, env, { helperPath, adapterPath: input.adapterPath, scriptIdentity }, versions, true);
  if (!provisional.sha256) throw new Error("runtime identity is incomplete");
  const runtime = resolveHssRuntimeIdentity(approvedDiscovery, env, {
    helperPath,
    adapterPath: input.adapterPath,
    scriptIdentity,
    validatedRuntimeIdentitySha256: [provisional.sha256],
  }, versions, true);
  if (!runtime.validated) throw new Error("runtime identity could not be validated");

  await validateLifecycle(input, runtime, scriptIdentity.sha256 ? [scriptIdentity.sha256] : []);
  return profileFrom(input, runtime, scriptIdentity);
}

async function validateLifecycle(input: TrustValidateInput, runtime: HssRuntimeIdentity, validatedJlinkScriptSha256: string[]): Promise<void> {
  const processManager = new ProcessManager();
  const probe = createProbeBackend({ type: "jlink", jlink: {
    device: input.targetId,
    interface: input.interface,
    speed: input.speedKhz,
    serialNumber: input.serial,
  } }, processManager);
  const service = new HssCaptureService(probe, {
    cwd: input.cwd,
    storageRoot: input.storageRoot,
    evidenceRoot: input.evidenceRoot,
    helperPath: runtime.helperPath,
    adapterPath: runtime.adapterPath,
    validatedDllSha256: [runtime.dllSha256!],
    validatedRuntimeIdentitySha256: [runtime.sha256!],
    validatedJlinkScriptSha256,
    trustValidation: true,
  });
  try {
    const script: HssScriptSpec = runtime.jlinkScriptMode === "none"
      ? { mode: "none" }
      : { mode: "file", path: runtime.jlinkScriptFile! };
    const plan = await service.capturePlan({
      targetId: input.targetId,
      dllPath: runtime.dllPath,
      interface: input.interface,
      speedKhz: input.speedKhz,
      serial: input.serial,
      script,
      artifactFile: input.artifactFile,
      mapFile: input.mapFile,
      symbols: [{ name: input.symbol, type: "uint32" }],
      requestedRateHz: input.rateHz,
      durationSec: input.durationSec,
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error?.message ?? "HSS validation plan failed");
    const started = await service.captureStart({ planId: plan.data.planId });
    if (!started.ok || !started.data) throw new Error(started.error?.message ?? "HSS validation capture failed to start");
    const deadline = Date.now() + plan.data.stabilityPolicy.timeoutMs + input.durationSec * 1000 + 2000;
    while (Date.now() < deadline) {
      const status = await service.captureStatus({ captureId: started.data.captureId as string });
      if (!status.ok || status.data?.state !== "capturing") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stopped = await service.captureStop({ captureId: started.data.captureId as string });
    if (!stopped.ok) throw new Error(stopped.error?.message ?? "HSS validation capture failed");
    const metadata = await readHssMetadata(started.data.metadataFile as string);
    const helper = [...metadata.events].reverse().find((event) => event.type === "helperResult")?.helperResult as Record<string, unknown> | undefined;
    const postConnect = helper?.postConnectStability as Record<string, unknown> | undefined;
    if (helper?.lifecycleValidated !== true || helper.decoderSemanticsValidated !== true
        || postConnect?.passed !== true) {
      throw new Error("bounded HSS lifecycle, post-connect stability, or decoder validation failed");
    }
  } finally {
    await service.dispose();
    probe.dispose();
  }
}

function profileFrom(input: TrustValidateInput, runtime: HssRuntimeIdentity, script: ReturnType<typeof resolveHssScriptIdentity>): Omit<HssTrustProfile, "profileSha256"> {
  const required = <T>(value: T | undefined, name: string): T => {
    if (value === undefined || value === "") throw new Error(`runtime identity is missing ${name}`);
    return value;
  };
  return {
    version: 1,
    suiteVersion: HSS_TRUST_SUITE_VERSION,
    validatedAt: new Date().toISOString(),
    runtime: {
      dllPath: required(runtime.dllPath, "dllPath"),
      dllSha256: required(runtime.dllSha256, "dllSha256"),
      dllVersion: required(runtime.dllVersion, "dllVersion"),
      helperPath: runtime.helperPath,
      helperSha256: required(runtime.helperSha256, "helperSha256"),
      helperVersion: required(runtime.helperVersion, "helperVersion"),
      helperProtocolVersion: required(runtime.helperProtocolVersion, "helperProtocolVersion"),
      adapterPath: runtime.adapterPath,
      adapterSha256: required(runtime.adapterSha256, "adapterSha256"),
      adapterVersion: runtime.adapterVersion,
      sha256: required(runtime.sha256, "sha256"),
    },
    script: { mode: script.mode, sourcePath: script.sourcePath, path: script.path, sha256: script.sha256 },
    project: hssTrustProjectIdentity(input.cwd),
    target: { targetId: input.targetId },
    probe: { serial: input.serial, interface: input.interface, speedKhz: input.speedKhz },
    validation: { getCaps: true, lifecycle: true, decoderSemantics: true },
  };
}

function parseTrustValidateArgs(argv: string[], requireExternalRoots: boolean): TrustValidateInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const mode = required("script-mode");
  if (mode !== "none" && mode !== "file") throw new Error("--script-mode must be none or file");
  const userAuthorized = values.get("user-authorized");
  if (userAuthorized !== undefined && userAuthorized !== "true" && userAuthorized !== "false") {
    throw new Error("--user-authorized must be true or false");
  }
  const script = mode === "none" ? { mode } as const : { mode, path: required("script-file") } as const;
  const interfaceName = values.get("interface") ?? "SWD";
  if (interfaceName !== "SWD" && interfaceName !== "JTAG") throw new Error("--interface must be SWD or JTAG");
  return {
    cwd: values.get("project") ?? process.cwd(),
    storageRoot: requireExternalRoots ? required("storage-root") : values.get("storage-root") ?? "",
    evidenceRoot: requireExternalRoots ? required("evidence-root") : values.get("evidence-root") ?? "",
    targetId: required("target"),
    dllPath: values.get("jlink-dll"),
    helperPath: values.get("helper"),
    adapterPath: values.get("adapter"),
    artifactFile: required("artifact"),
    mapFile: values.get("map"),
    symbol: required("symbol"),
    script,
    serial: values.get("probe-serial"),
    interface: interfaceName,
    speedKhz: positiveInteger(values.get("speed"), 4000, "speed"),
    rateHz: positiveInteger(values.get("rate"), 100, "rate"),
    durationSec: positiveInteger(values.get("duration"), 1, "duration"),
    userAuthorized: userAuthorized === "true",
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

async function confirmTrust(_summary: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("interactive local confirmation is required");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return /^y(?:es)?$/i.test((await prompt.question("Trust this exact runtime tuple? [y/N] ")).trim());
  } finally {
    prompt.close();
  }
}
