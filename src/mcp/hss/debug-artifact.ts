import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { existingInsideProject } from "./project-paths";
import { HSS_ERROR, HssError } from "./hss-errors";
import { resolveIarMapSymbols } from "./iar-map-parser";
import type { HssRequestedSymbol, HssResolvedSymbol } from "./hss-contract";

export interface HssArtifactResolution {
  artifactFile: string;
  mapFile?: string;
  sha256: string;
  resolver: "elf-dwarf" | "iar-map" | "mixed";
  symbols: HssResolvedSymbol[];
}

export async function resolveHssDebugArtifact(input: {
  artifactFile?: string;
  mapFile?: string;
  symbols: HssRequestedSymbol[];
  cwd?: string;
}): Promise<HssArtifactResolution> {
  const cwd = input.cwd ?? process.cwd();
  const artifactFile = input.artifactFile
    ? await existingInsideProject(input.artifactFile, cwd)
    : latestNamedFile(cwd, "FOC_SCM.out");
  if (!artifactFile) throw new HssError(HSS_ERROR.ARTIFACT_NOT_FOUND, "FOC_SCM.out was not found under cwd");
  assertSupportedArtifactByContent(artifactFile);
  const mapFile = input.mapFile
    ? await existingInsideProject(input.mapFile, cwd)
    : latestNamedFile(cwd, "FOC_SCM.map");
  const symbols = mapFile ? resolveIarMapSymbols(mapFile, input.symbols) : [];
  if (!mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "FOC_SCM.map fallback was not found");
  return {
    artifactFile,
    mapFile,
    sha256: createHash("sha256").update(readFileSync(artifactFile)).digest("hex"),
    resolver: "iar-map",
    symbols,
  };
}

export function latestNamedFile(cwd: string, fileName: string): string | undefined {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) found.push(full);
    }
  };
  walk(cwd);
  return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

export function assertSupportedArtifactByContent(file: string): void {
  const ext = extname(file).toLowerCase();
  if ([".hex", ".bin", ".srec", ".s19"].includes(ext)) {
    throw new HssError(HSS_ERROR.UNSUPPORTED_ARTIFACT, `${basename(file)} cannot be used for variable resolution`);
  }
  if (!existsSync(file)) throw new HssError(HSS_ERROR.ARTIFACT_NOT_FOUND, `artifact not found: ${file}`);
  const raw = readFileSync(file).subarray(0, 4);
  if (raw.length < 4 || raw[0] !== 0x7f || raw.toString("ascii", 1, 4) !== "ELF") {
    throw new HssError(HSS_ERROR.UNSUPPORTED_ARTIFACT, "debug artifact is not ELF content");
  }
}
