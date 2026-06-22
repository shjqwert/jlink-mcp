import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import {
  CaptureSymbol,
  MAX_CAPTURE_SYMBOLS,
  ProjectControlConfig,
  ScalarType,
  projectControlConfigSchema,
} from "../mcp/capture-contract";

const execFileAsync = promisify(execFile);
const selectorPattern = /^(?:[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const gdbTimeoutMs = 30000;

export interface RequestedCaptureSymbol {
  name: string;
  alias?: string;
  unit?: string;
}

export interface ElfSection {
  name: string;
  start: number;
  end: number;
  flags: string[];
}

export interface FlashSection extends ElfSection {
  dataHex: string;
}

export interface ElfResolution {
  elfPath: string;
  elfSha256: string;
  symbols: CaptureSymbol[];
  sections: ElfSection[];
  ramRanges: Array<{ start: number; end: number }>;
  flashSections: FlashSection[];
}

export interface LoadedProjectConfig {
  path: string;
  config: ProjectControlConfig;
}

export function validateSelector(selector: string): void {
  if (!selectorPattern.test(selector) || selector.includes("->") || selector.includes("[") || selector.includes("]")) {
    throw new Error(`Unsafe selector "${selector}": only fixed global/static scalar member paths are allowed`);
  }
}

export function parseGdbSections(output: string): ElfSection[] {
  const sections: ElfSection[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/(?:\[\s*\d+\]\s+)?(0x[0-9a-f]+)\s*->\s*(0x[0-9a-f]+)\s+at\s+0x[0-9a-f]+:\s+(\S+)\s*(.*)$/i);
    if (!match) continue;
    const start = Number.parseInt(match[1], 16);
    const end = Number.parseInt(match[2], 16);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue;
    sections.push({ name: match[3], start, end, flags: match[4].trim().split(/\s+/).filter(Boolean) });
  }
  return sections;
}

function scalarType(typeText: string, size: number): ScalarType | null {
  const type = typeText
    .replace(/^type\s*=\s*/i, "")
    .replace(/\b(const|volatile|restrict|__attribute__\s*\(\([^)]*\)\))\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (size === 1 && /^(int8_t|signed char)$/.test(type)) return "int8";
  if (size === 1 && /^(uint8_t|unsigned char)$/.test(type)) return "uint8";
  if (size === 2 && /^(int16_t|short|short int|signed short|signed short int)$/.test(type)) return "int16";
  if (size === 2 && /^(uint16_t|unsigned short|unsigned short int)$/.test(type)) return "uint16";
  if (size === 4 && /^(int32_t|int|signed|signed int|long|long int|signed long|signed long int)$/.test(type)) return "int32";
  if (size === 4 && /^(uint32_t|unsigned|unsigned int|unsigned long|unsigned long int)$/.test(type)) return "uint32";
  if (size === 4 && type === "float") return "float32";
  return null;
}

export function parseGdbSymbolOutput(output: string, requested: RequestedCaptureSymbol[], sections: ElfSection[]): CaptureSymbol[] {
  const errors: string[] = [];
  const symbols: CaptureSymbol[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const block = output.match(new RegExp(`__JL_BEGIN_${index}__([\\s\\S]*?)__JL_END_${index}__`))?.[1] ?? "";
    const rootBlock = output.match(new RegExp(`__JL_ROOT_BEGIN_${index}__([\\s\\S]*?)__JL_ROOT_END_${index}__`))?.[1] ?? "";
    const layoutBlock = output.match(new RegExp(`__JL_LAYOUT_BEGIN_${index}__([\\s\\S]*?)__JL_LAYOUT_END_${index}__`))?.[1] ?? "";
    const addressText = block.match(new RegExp(`__JL_ADDR_${index}__=(0x[0-9a-f]+)`, "i"))?.[1];
    const sizeText = block.match(new RegExp(`__JL_SIZE_${index}__=(\\d+)`))?.[1];
    const typeText = block.match(/type\s*=\s*([^\r\n]+)/i)?.[0];
    const selectorErrors = block.split(/\r?\n/).filter((line) => /No symbol|optimized out|ambiguous|not defined|Attempt to take address|There is no member/i.test(line));
    const duplicateStaticRoots = (rootBlock.match(/^File\s+/gm) ?? []).length > 1;
    const finalMember = requested[index].name.split(".").at(-1)!;
    const bitfield = new RegExp(`\\b${finalMember}\\s*:\\s*\\d+\\s*;`).test(layoutBlock);
    if (!addressText || !sizeText || !typeText || selectorErrors.length > 0 || duplicateStaticRoots || bitfield) {
      if (duplicateStaticRoots) selectorErrors.push("ambiguous static root; use source-file::symbol");
      if (bitfield) selectorErrors.push("bitfields are forbidden");
      errors.push(`${requested[index].name}: ${selectorErrors.join("; ") || "could not resolve address, size, and type"}`);
      continue;
    }
    const address = Number.parseInt(addressText, 16);
    const size = Number.parseInt(sizeText, 10);
    const type = scalarType(typeText, size);
    const section = sections.find((candidate) => address >= candidate.start && address + size <= candidate.end);
    const writableRam = !!section && section.flags.includes("ALLOC") && !section.flags.includes("READONLY") && !section.flags.includes("CODE");
    if (!type) errors.push(`${requested[index].name}: unsupported final scalar type ${typeText.replace(/^type\s*=\s*/i, "")}`);
    else if (![1, 2, 4].includes(size) || address % size !== 0) errors.push(`${requested[index].name}: address 0x${address.toString(16)} is not naturally aligned`);
    else if (address < 0 || address + size > 0x1_0000_0000 || address >= 0x4000_0000 && address < 0x6000_0000 || address >= 0xe000_0000) errors.push(`${requested[index].name}: address is in a forbidden peripheral/debug range`);
    else if (!writableRam) errors.push(`${requested[index].name}: address is not in an ELF writable RAM section`);
    else symbols.push({ ...requested[index], address, size, type });
  }
  if (errors.length > 0) throw new Error(`ELF selector validation failed:\n${errors.join("\n")}`);
  return symbols;
}

async function runGdb(gdbPath: string, elfPath: string, commands: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(gdbPath, ["--batch", "--nx", "--quiet", elfPath, ...commands.flatMap((command) => ["-ex", command])], {
      encoding: "utf8",
      timeout: gdbTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout + "\n" + stderr;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`arm-none-eabi-gdb failed: ${detail}`);
  }
}

function gdbExpression(selector: string): string {
  validateSelector(selector);
  const separator = selector.indexOf("::");
  if (separator < 0) return selector;
  const source = selector.slice(0, separator).replace(/\\/g, "/");
  return `'${source}'::${selector.slice(separator + 2)}`;
}

function mergeRanges(sections: ElfSection[]): Array<{ start: number; end: number }> {
  const ranges = sections
    .filter((section) => section.flags.includes("ALLOC") && !section.flags.includes("READONLY") && !section.flags.includes("CODE"))
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function parseElfFlashSegments(data: Buffer, ramRanges: Array<{ start: number; end: number }>): FlashSection[] {
  if (data.length < 52 || data.toString("ascii", 0, 4) !== "\x7fELF") throw new Error("Invalid ELF header");
  if (data[4] !== 1) throw new Error("Only ELF32 targets are supported");
  if (data[5] !== 1) throw new Error("Only little-endian ELF files are supported");
  const programOffset = data.readUInt32LE(28);
  const entrySize = data.readUInt16LE(42);
  const entryCount = data.readUInt16LE(44);
  if (entrySize < 32 || programOffset + entrySize * entryCount > data.length) throw new Error("Invalid ELF program-header table");
  const segments: FlashSection[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = programOffset + index * entrySize;
    if (data.readUInt32LE(offset) !== 1) continue;
    const fileOffset = data.readUInt32LE(offset + 4);
    const virtualAddress = data.readUInt32LE(offset + 8);
    const physicalAddress = data.readUInt32LE(offset + 12);
    const fileSize = data.readUInt32LE(offset + 16);
    const flags = data.readUInt32LE(offset + 24);
    if (fileSize === 0) continue;
    if (fileOffset + fileSize > data.length || physicalAddress + fileSize > 0x1_0000_0000) throw new Error("Invalid ELF load segment bounds");
    const physicalInRam = ramRanges.some((range) => physicalAddress >= range.start && physicalAddress + fileSize <= range.end);
    if (physicalInRam && physicalAddress === virtualAddress) continue;
    segments.push({
      name: `PT_LOAD_${index}`,
      start: physicalAddress,
      end: physicalAddress + fileSize,
      flags: [flags & 1 ? "EXEC" : "", flags & 2 ? "WRITE" : "", flags & 4 ? "READ" : ""].filter(Boolean),
      dataHex: data.subarray(fileOffset, fileOffset + fileSize).toString("hex"),
    });
  }
  segments.sort((left, right) => left.start - right.start);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start < segments[index - 1].end) throw new Error("Overlapping ELF Flash load segments are unsupported");
  }
  const total = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  if (total === 0) throw new Error("ELF has no loadable Flash segments");
  if (total > 64 * 1024 * 1024) throw new Error("ELF loadable Flash segments exceed the 64 MiB validation limit");
  return segments;
}

export async function resolveElfSymbols(gdbPath: string, elfFile: string, requested: RequestedCaptureSymbol[]): Promise<ElfResolution> {
  if (!isAbsolute(elfFile)) throw new Error("elfFile must be an absolute path");
  if (requested.length < 1 || requested.length > MAX_CAPTURE_SYMBOLS + 4) throw new Error(`ELF resolution accepts at most ${MAX_CAPTURE_SYMBOLS} capture symbols plus four control selectors`);
  for (const symbol of requested) validateSelector(symbol.name);
  const elfPath = await realpath(elfFile);
  if (!(await stat(elfPath)).isFile()) throw new Error("elfFile must select a regular file");

  const commands = ["set pagination off", "show endian", "maintenance info sections"];
  for (let index = 0; index < requested.length; index += 1) {
    const expression = gdbExpression(requested[index].name);
    commands.push(
      `echo __JL_BEGIN_${index}__\\n`,
      `printf \"__JL_ADDR_${index}__=0x%llx\\n\", (unsigned long long)&(${expression})`,
      `printf \"__JL_SIZE_${index}__=%llu\\n\", (unsigned long long)sizeof(${expression})`,
      `ptype ${expression}`,
      `echo __JL_END_${index}__\\n`,
    );
    if (!requested[index].name.includes("::")) {
      const root = requested[index].name.split(".", 1)[0];
      commands.push(
        `echo __JL_ROOT_BEGIN_${index}__\\n`,
        `info variables ^${root}$`,
        `echo __JL_ROOT_END_${index}__\\n`,
      );
    }
    const memberSelector = requested[index].name.includes("::") ? requested[index].name.split("::", 2)[1] : requested[index].name;
    if (memberSelector.includes(".")) {
      const prefix = requested[index].name.includes("::") ? `${requested[index].name.split("::", 2)[0]}::` : "";
      const rootExpression = gdbExpression(prefix + memberSelector.split(".", 1)[0]);
      commands.push(
        `echo __JL_LAYOUT_BEGIN_${index}__\\n`,
        `ptype ${rootExpression}`,
        `echo __JL_LAYOUT_END_${index}__\\n`,
      );
    }
  }
  const output = await runGdb(gdbPath, elfPath, commands);
  if (!/little endian/i.test(output)) throw new Error("Only little-endian ELF files are supported");
  const sections = parseGdbSections(output);
  if (sections.length === 0) throw new Error("Could not read ELF section layout");
  const symbols = parseGdbSymbolOutput(output, requested, sections);
  const elfData = await readFile(elfPath);
  const elfSha256 = createHash("sha256").update(elfData).digest("hex");
  const ramRanges = mergeRanges(sections);
  const flashSections = parseElfFlashSegments(elfData, ramRanges);
  return { elfPath, elfSha256, symbols, sections, ramRanges, flashSections };
}

export async function loadProjectControlConfig(configFile: string): Promise<LoadedProjectConfig> {
  if (!isAbsolute(configFile)) throw new Error("configFile must be an absolute path");
  if (basename(configFile) !== ".jlink-mcp.json") throw new Error("configFile must select .jlink-mcp.json");
  const path = await realpath(configFile);
  if ((await stat(path)).size > 1024 * 1024) throw new Error(".jlink-mcp.json exceeds the 1 MiB limit");
  const config = projectControlConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));

  let repository = dirname(path);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
    repository = stdout.trim();
    const trackedPath = relative(repository, path).replace(/\\/g, "/");
    await execFileAsync("git", ["-C", repository, "ls-files", "--error-unmatch", "--", trackedPath], { encoding: "utf8", windowsHide: true });
  } catch {
    throw new Error(".jlink-mcp.json must be tracked by the containing Git repository");
  }
  return { path, config };
}
