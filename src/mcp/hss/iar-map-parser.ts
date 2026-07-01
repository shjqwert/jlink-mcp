import { readFileSync } from "node:fs";
import type { HssRequestedSymbol, HssResolvedSymbol, HssScalarType } from "./hss-contract";
import { HSS_ERROR, HssError } from "./hss-errors";

export interface IarMapSymbol {
  name: string;
  address: number;
  size: number;
}

export function parseIarMap(mapFile: string): Map<string, IarMapSymbol[]> {
  const symbols = new Map<string, IarMapSymbol[]>();
  const linePattern = /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+0x([0-9a-fA-F']+)\s+0x([0-9a-fA-F]+)\s+Data\s+\w+\b/;
  for (const line of readFileSync(mapFile, "utf8").split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;
    const item = {
      name: match[1],
      address: Number.parseInt(match[2].replace(/'/g, ""), 16),
      size: Number.parseInt(match[3], 16),
    };
    symbols.set(item.name, [...(symbols.get(item.name) ?? []), item]);
  }
  return symbols;
}

export function resolveIarMapSymbols(mapFile: string, requested: HssRequestedSymbol[]): HssResolvedSymbol[] {
  validateRequestedSymbols(requested);
  const map = parseIarMap(mapFile);
  return requested.map((request) => {
    const matches = map.get(request.name) ?? [];
    if (matches.length === 0) throw new HssError(HSS_ERROR.SYMBOL_NOT_FOUND, `symbol not found in IAR map: ${request.name}`);
    if (matches.length > 1) throw new HssError(HSS_ERROR.SYMBOL_DUPLICATE, `duplicate symbol in IAR map: ${request.name}`);
    const match = matches[0];
    const type = request.type ?? inferMapType(request.name, match.size);
    if (!type) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `type is required for map-only symbol: ${request.name}`);
    validateRamScalar(request.name, match.address, match.size, type);
    return {
      name: request.name,
      alias: request.alias,
      unit: request.unit,
      address: `0x${match.address.toString(16).padStart(8, "0")}`,
      size: match.size,
      type,
      source: "iar-map",
    };
  });
}

export function validateRequestedSymbols(requested: HssRequestedSymbol[]): void {
  const seen = new Set<string>();
  for (const symbol of requested) {
    if (!/^(?:[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(symbol.name)
      || /->|\[|\]|\*|&/.test(symbol.name)) {
      throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `unsafe selector rejected: ${symbol.name}`);
    }
    if (seen.has(symbol.name)) throw new HssError(HSS_ERROR.SYMBOL_DUPLICATE, `duplicate variable name: ${symbol.name}`);
    seen.add(symbol.name);
  }
}

function inferMapType(name: string, size: number): HssScalarType | null {
  if (/Offset/i.test(name) && size === 2) return "int16";
  if (size === 1) return "uint8";
  if (size === 2) return "uint16";
  if (size === 4) return "uint32";
  return null;
}

function scalarSize(type: HssScalarType): number {
  if (type === "uint8" || type === "int8") return 1;
  if (type === "uint16" || type === "int16") return 2;
  return 4;
}

export function validateRamScalar(name: string, address: number, size: number, type: HssScalarType): void {
  if (![1, 2, 4].includes(size)) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `unsupported scalar size for ${name}: ${size}`);
  if (scalarSize(type) !== size) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `type/size mismatch for ${name}`);
  if (address % size !== 0) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `unaligned address for ${name}`);
  if (address < 0x20000000 || address >= 0x40000000) {
    throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `address is not eligible RAM for ${name}`, { address: `0x${address.toString(16)}` });
  }
}
