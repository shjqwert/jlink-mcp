import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CaptureMetadata, CaptureSymbol } from "./capture-contract";
import {
  ExperimentRecord,
  ExperimentSample,
  SignalRole,
  experimentRecordSchema,
} from "./experiment-contract";
import {
  captureSampleSignalName,
  readCaptureSamples,
  selectSessionArtifacts,
} from "./capture-storage";

export interface LoadExperimentInput {
  experimentId?: string;
  fixturePath?: string;
  experimentPath?: string;
  metadataFile?: string;
  captureId?: string;
  outputDir?: string;
  signalRoles?: Record<string, SignalRole>;
  variables?: string[];
  startSec?: number;
  endSec?: number;
  maxSamples?: number;
}

export interface LoadedExperiment {
  experimentId: string;
  record: ExperimentRecord;
  qualityWarnings: string[];
}

export interface CaptureConversionOptions {
  metadataFile?: string;
  signalRoles?: Record<string, SignalRole>;
  variables?: string[];
  startSec?: number;
  endSec?: number;
  maxSamples?: number;
}

export async function loadExperimentForAnalysis(input: LoadExperimentInput): Promise<LoadedExperiment> {
  if (input.experimentPath) {
    const record = await readExperimentFile(input.experimentPath);
    return { experimentId: record.experimentId, record, qualityWarnings: [] };
  }
  if (input.metadataFile) {
    const metadataFile = await requireExplicitFile(input.metadataFile, ".metadata.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as CaptureMetadata;
    const record = await captureMetadataToExperimentRecord(metadata, { ...input, metadataFile });
    return { experimentId: record.experimentId, record, qualityWarnings: record.metadata?.sampleWarnings as string[] ?? [] };
  }
  if (input.captureId) {
    const metadataFile = await metadataFileForCapture(input.captureId, input.outputDir);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as CaptureMetadata;
    const record = await captureMetadataToExperimentRecord(metadata, { ...input, metadataFile });
    return { experimentId: record.experimentId, record, qualityWarnings: record.metadata?.sampleWarnings as string[] ?? [] };
  }
  const fixtureFile = input.fixturePath ? fixturePath(input.fixturePath) : await fixturePathForId(input.experimentId ?? "");
  if (!fixtureFile) throw new Error(`Experiment fixture not found: ${input.experimentId ?? input.fixturePath ?? "(missing)"}`);
  const record = await readExperimentFile(fixtureFile);
  return { experimentId: input.experimentId ?? record.experimentId, record, qualityWarnings: [] };
}

export async function captureMetadataToExperimentRecord(metadata: CaptureMetadata, options: CaptureConversionOptions = {}): Promise<ExperimentRecord> {
  const metadataFile = options.metadataFile ? await requireExplicitFile(options.metadataFile, ".metadata.json") : undefined;
  const binaryFile = await requireCaptureBinary(metadata.binaryFile, metadataFile, metadata.sessionId);
  const samples = await readCaptureSamples(binaryFile, {
    variables: options.variables,
    startSec: options.startSec,
    endSec: options.endSec,
    maxSamples: options.maxSamples,
  });
  const signals = samples.variables.map((variable) => {
    const symbol = metadata.symbols.find((item) => item.name === variable.selector || item.alias === variable.alias) ?? {
      name: variable.selector,
      alias: variable.alias,
      unit: variable.unit,
      type: variable.type,
    } as CaptureSymbol;
    return {
      name: variable.name,
      selector: variable.selector,
      type: variable.type,
      unit: variable.unit,
      role: roleFor(symbol, variable.name, options.signalRoles),
    };
  });
  const record = {
    experimentId: `capture_${metadata.sessionId}`,
    createdAt: createdAtFromMetadataFile(metadataFile),
    source: "capture" as const,
    target: {
      device: metadata.device,
      speedKhz: metadata.swdRateKhz,
    },
    capture: {
      captureId: metadata.sessionId,
      backend: "jlink-gdb-rsp",
      actualRateHz: positive(metadata.timing?.actualRateHz),
      quality: {
        ...metadata.timing,
        failures: metadata.failures,
        resets: metadata.resets,
        terminationReason: metadata.terminationReason,
      },
    },
    signals,
    events: metadata.events.map((event) => ({
      timeMs: eventTimeMs(event.qpc, samples.firstQpc, samples.qpcFrequency),
      type: event.type,
      detail: event.detail,
      metadata: { success: event.success, qpc: event.qpc },
    })),
    samples: samples.samples.map((sample): ExperimentSample => ({
      timeMs: sample.timeSec * 1000,
      values: Object.fromEntries(Object.entries(sample.values).map(([name, value]) => [name, Number.isFinite(value) ? value : String(value)])),
    })),
    artifacts: {
      raw: binaryFile,
      ...(metadataFile ? { metadata: metadataFile } : {}),
    },
    metadata: {
      sampleWarnings: samples.warnings,
    },
  };
  return experimentRecordSchema.parse(record);
}

async function readExperimentFile(filePath: string): Promise<ExperimentRecord> {
  const real = await requireExplicitFile(filePath, ".experiment.json");
  return experimentRecordSchema.parse(JSON.parse(await readFile(real, "utf8")));
}

async function fixturePathForId(experimentId: string): Promise<string | null> {
  const slug = experimentId.replace(/^fixture_/, "").replace(/_/g, "-");
  for (const candidate of [`${experimentId}.experiment.json`, `${slug}.experiment.json`]) {
    try {
      const filePath = fixturePath(candidate);
      await stat(filePath);
      return filePath;
    } catch {
      // Try the next fixture spelling.
    }
  }
  return null;
}

function fixturePath(filePath: string): string {
  if (isAbsolute(filePath) || hasWildcard(filePath)) throw new Error("fixturePath must be a relative file path without wildcards");
  const root = resolve(process.cwd(), "src", "mcp", "fixtures");
  const resolved = resolve(root, filePath);
  if (!resolved.toLowerCase().startsWith(root.toLowerCase() + sep)) throw new Error("fixturePath escapes fixture directory");
  return resolved;
}

async function metadataFileForCapture(captureId: string, outputDir?: string): Promise<string> {
  if (!isSessionId(captureId)) throw new Error("captureId must be an exact UUID");
  if (!outputDir || !isAbsolute(outputDir) || hasWildcard(outputDir)) throw new Error("outputDir must be an existing absolute directory without wildcards");
  const directory = await realpath(outputDir);
  if (!(await stat(directory)).isDirectory()) throw new Error("outputDir must be an existing directory");
  const artifacts = selectSessionArtifacts(await readdir(directory), captureId);
  const metadataName = artifacts.find((name) => name.endsWith(".metadata.json"));
  if (!metadataName) throw new Error(`Capture metadata not found: ${captureId}`);
  return join(directory, metadataName);
}

async function requireExplicitFile(filePath: string, suffix: string): Promise<string> {
  if (!isAbsolute(filePath) || hasWildcard(filePath)) throw new Error(`${suffix} path must be an absolute file path without wildcards`);
  const real = await realpath(filePath);
  if (!real.toLowerCase().endsWith(suffix.toLowerCase())) throw new Error(`Expected ${suffix} file`);
  if (!(await stat(real)).isFile()) throw new Error(`${suffix} path must be a file`);
  return real;
}

async function requireCaptureBinary(filePath: string, metadataFile: string | undefined, sessionId: string): Promise<string> {
  const real = await requireExplicitFile(filePath, ".jlcp");
  if (metadataFile && dirname(real).toLowerCase() !== dirname(metadataFile).toLowerCase()) throw new Error("Capture metadata binaryFile escapes its metadata directory");
  const fileName = basename(real);
  if (!selectSessionArtifacts([fileName], sessionId).includes(fileName)) throw new Error("Capture metadata binaryFile does not match its sessionId");
  return real;
}

function roleFor(symbol: CaptureSymbol, signalName: string, overrides?: Record<string, SignalRole>): SignalRole {
  return overrides?.[signalName] ?? overrides?.[symbol.name] ?? (symbol.alias ? overrides?.[symbol.alias] : undefined) ?? "raw";
}

function createdAtFromMetadataFile(metadataFile?: string): string {
  const stamp = metadataFile?.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-/)?.[1];
  return stamp ? new Date(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z")).toISOString() : new Date(0).toISOString();
}

function eventTimeMs(qpc: string, firstQpc: bigint, qpcFrequency: bigint): number {
  const value = BigInt(qpc);
  return Math.max(0, Number(value - firstQpc) * 1000 / Number(qpcFrequency));
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hasWildcard(value: string): boolean {
  return /[*?]/.test(value);
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
