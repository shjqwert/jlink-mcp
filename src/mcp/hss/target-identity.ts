import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { HssTargetConfigurationSource, HssTargetIdentity } from "./hss-contract";
import { HSS_ERROR, HssError } from "./hss-errors";

const MAX_CONFIGURATION_FILES = 64;
const MAX_CONFIGURATION_DIRECTORIES = 2048;
const MAX_CONFIGURATION_DEPTH = 32;
const MAX_REPORTED_TARGETS = 16;
const IAR_TARGET_OPTIONS = new Set(["OGChipSelectEditMenu", "GFPUDeviceSlave", "OGCMSISPackSelectDevice"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".jlink-mcp"]);

export interface HssTargetIdentityInput {
  device?: string;
  targetId?: string;
  projectRoot?: string;
  projectConfigFile?: string;
}

export interface HssTargetIdentityOptions {
  cwd?: string;
}

interface HssTargetCandidate {
  targetId: string;
  source: HssTargetConfigurationSource;
}

interface ConfigScan {
  files: string[];
  directories: number;
  truncated: boolean;
}

export async function resolveHssTargetIdentity(
  input: HssTargetIdentityInput = {},
  options: HssTargetIdentityOptions = {},
): Promise<HssTargetIdentity> {
  const explicit = explicitTargets(input);
  const explicitIds = [...new Set(explicit.map((candidate) => candidate.targetId))];
  if (explicitIds.length === 1) {
    return {
      targetId: explicitIds[0],
      source: "explicit",
      confidence: "explicit",
    };
  }
  if (explicitIds.length > 1) {
    throw selectionRequired({
      reason: "conflicting_explicit_targets",
      candidates: explicit,
      sources: explicit.map((candidate) => candidate.source),
    });
  }

  const projectRoot = resolve(input.projectRoot ?? options.cwd ?? process.cwd());
  const selectedFile = input.projectConfigFile
    ? resolveProjectConfigFile(input.projectConfigFile, projectRoot)
    : undefined;
  if (selectedFile && !isSupportedConfig(selectedFile)) {
    throw selectionRequired({
      reason: "unsupported_project_config",
      projectRoot,
      projectConfigFile: selectedFile,
      candidates: [],
      sources: [],
    });
  }

  const scan = selectedFile
    ? { files: [selectedFile], directories: 0, truncated: false }
    : await scanSupportedConfigs(projectRoot);
  const configSources = scan.files.map(sourceForConfig);
  const candidates: HssTargetCandidate[] = [];
  const unreadableSources: Array<{ file: string; reason: string }> = [];
  for (const file of scan.files) {
    try {
      const contents = (await readFile(file)).toString("utf8").replace(/\0/g, "");
      const targetIds = extname(file).toLowerCase() === ".ewp"
        ? iarTargetIds(contents)
        : jlinkTargetIds(contents);
      const source = sourceForConfig(file);
      for (const targetId of targetIds) candidates.push({ targetId, source });
    } catch (error) {
      unreadableSources.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const distinct = distinctCandidates(candidates);
  if (!scan.truncated && unreadableSources.length === 0 && distinct.length === 1) {
    return {
      targetId: distinct[0].targetId,
      source: "project-config",
      confidence: "project-config",
      configurationSource: distinct[0].source,
    };
  }

  throw selectionRequired({
    reason: scan.truncated ? "bounded_config_scan_incomplete" : distinct.length ? "ambiguous_project_targets" : "target_not_found",
    projectRoot,
    projectConfigFile: selectedFile,
    candidates: distinct.slice(0, MAX_REPORTED_TARGETS),
    sources: uniqueSources(configSources).slice(0, MAX_REPORTED_TARGETS),
    unreadableSources: unreadableSources.slice(0, MAX_REPORTED_TARGETS),
    scan: {
      scannedConfigFiles: scan.files.length,
      scannedDirectories: scan.directories,
      truncated: scan.truncated,
      maxConfigFiles: MAX_CONFIGURATION_FILES,
      maxDirectories: MAX_CONFIGURATION_DIRECTORIES,
      maxDepth: MAX_CONFIGURATION_DEPTH,
    },
  });
}

function explicitTargets(input: HssTargetIdentityInput): Array<{ targetId: string; source: { input: "targetId" | "device" } }> {
  const values: Array<["targetId" | "device", string | undefined]> = [["targetId", input.targetId], ["device", input.device]];
  return values.flatMap(([inputName, value]) => {
    const targetId = normalizeTargetId(value);
    return targetId ? [{ targetId, source: { input: inputName } }] : [];
  });
}

async function scanSupportedConfigs(projectRoot: string): Promise<ConfigScan> {
  const scan: ConfigScan = { files: [], directories: 0, truncated: false };
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (scan.truncated) return;
    if (depth > MAX_CONFIGURATION_DEPTH || scan.directories >= MAX_CONFIGURATION_DIRECTORIES) {
      scan.truncated = true;
      return;
    }
    scan.directories += 1;
    try {
      const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (scan.truncated) return;
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(file, depth + 1);
        } else if (entry.isFile() && isSupportedConfig(file)) {
          if (scan.files.length >= MAX_CONFIGURATION_FILES) {
            scan.truncated = true;
            return;
          }
          scan.files.push(file);
        }
      }
    } catch {
      scan.truncated = true;
    }
  };
  await visit(projectRoot, 0);
  return scan;
}

function resolveProjectConfigFile(file: string, projectRoot: string): string {
  return resolve(isAbsolute(file) ? file : join(projectRoot, file));
}

function isSupportedConfig(file: string): boolean {
  const extension = extname(file).toLowerCase();
  return extension === ".ewp" || extension === ".jlink";
}

function sourceForConfig(file: string): HssTargetConfigurationSource {
  return { file, format: extname(file).toLowerCase() === ".ewp" ? "iar-ewp" : "jlink" };
}

function iarTargetIds(contents: string): string[] {
  const targetIds: string[] = [];
  for (const option of contents.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)) {
    const name = xmlElement(option[1], "name");
    if (!name || !IAR_TARGET_OPTIONS.has(name.trim())) continue;
    const targetId = normalizeTargetId(xmlElement(option[1], "state")?.split(/\s+/)[0]);
    if (targetId) targetIds.push(targetId);
  }
  return [...new Set(targetIds)];
}

function xmlElement(contents: string, name: string): string | undefined {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(contents)?.[1];
}

function jlinkTargetIds(contents: string): string[] {
  const targetIds: string[] = [];
  for (const match of contents.matchAll(/^\s*Device\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\r\n]*))\s*(?:;.*)?$/gim)) {
    const targetId = normalizeTargetId(match[1] ?? match[2] ?? match[3]);
    if (targetId) targetIds.push(targetId);
  }
  return [...new Set(targetIds)];
}

function normalizeTargetId(value: string | undefined): string | undefined {
  const targetId = value?.trim();
  return targetId && !/^unspecified$/i.test(targetId) ? targetId : undefined;
}

function distinctCandidates(candidates: HssTargetCandidate[]): HssTargetCandidate[] {
  const byTarget = new Map<string, HssTargetCandidate>();
  for (const candidate of candidates) {
    const current = byTarget.get(candidate.targetId);
    if (!current || candidate.source.file.localeCompare(current.source.file) < 0) byTarget.set(candidate.targetId, candidate);
  }
  return [...byTarget.values()].sort((left, right) => left.targetId.localeCompare(right.targetId) || left.source.file.localeCompare(right.source.file));
}

function uniqueSources(sources: HssTargetConfigurationSource[]): HssTargetConfigurationSource[] {
  const byFile = new Map<string, HssTargetConfigurationSource>();
  for (const source of sources) byFile.set(source.file, source);
  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function selectionRequired(details: Record<string, unknown>): HssError {
  return new HssError(HSS_ERROR.HSS_TARGET_SELECTION_REQUIRED, "HSS target selection is required", details);
}
