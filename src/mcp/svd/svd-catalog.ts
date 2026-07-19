import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type SvdAccess = "read-only" | "write-only" | "read-write" | "writeOnce" | "read-writeOnce";

export interface SvdField {
  name: string;
  lsb: number;
  width: number;
  mask: number;
  access?: SvdAccess;
  readAction?: string;
  modifiedWriteValues?: string;
}

export interface SvdRegister {
  peripheral: string;
  name: string;
  selector: string;
  address: number;
  width: 8 | 16 | 32;
  access?: SvdAccess;
  readAction?: string;
  modifiedWriteValues?: string;
  resetValue?: number;
  resetMask?: number;
  reservedMask: number;
  fields: SvdField[];
}

export interface SvdResolvedSelector {
  selector: string;
  register: SvdRegister;
  field?: SvdField;
}

export class SvdCatalogError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SvdCatalogError";
  }
}

export class SvdCatalog {
  private readonly selectors = new Map<string, SvdResolvedSelector[]>();

  constructor(readonly path: string, readonly sha256: string, readonly endian: "little" | "big", readonly registers: readonly SvdRegister[]) {
    for (const register of registers) {
      this.add(register.selector, { selector: register.selector, register });
      for (const field of register.fields) this.add(`${register.selector}.${field.name}`, { selector: `${register.selector}.${field.name}`, register, field });
    }
  }

  resolve(selector: string): SvdResolvedSelector {
    if (!/^[A-Za-z_]\w*\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(selector)) {
      throw new SvdCatalogError("SVD_SELECTOR_INVALID", "selector must be exactly PERIPHERAL.REGISTER or PERIPHERAL.REGISTER.FIELD");
    }
    const matches = this.selectors.get(selector) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new SvdCatalogError("SVD_SELECTOR_AMBIGUOUS", `SVD selector is duplicated: ${selector}`, { count: matches.length });
    const prefix = selector.split(".").slice(0, 2).join(".");
    const candidates = [...this.selectors.keys()].filter((value) => value === prefix || value.startsWith(`${prefix}.`)).slice(0, 16);
    throw new SvdCatalogError("SVD_SELECTOR_NOT_FOUND", `SVD selector was not found exactly: ${selector}`, { candidates });
  }

  private add(selector: string, resolved: SvdResolvedSelector): void {
    this.selectors.set(selector, [...(this.selectors.get(selector) ?? []), resolved]);
  }
}

export function loadSvdCatalog(path: string, expectedSha256?: string): SvdCatalog {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) throw new SvdCatalogError("SVD_GENERATION_STALE", "SVD content changed after target_configure");
  const root = parseXml(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (root.name !== "device") throw new SvdCatalogError("SVD_FORMAT_INVALID", "SVD root element must be <device>");
  rejectUnsupportedNode(root, "device");
  const endianText = optionalText(child(root, "cpu") ?? root, "endian");
  if (endianText !== "little" && endianText !== "big") throw new SvdCatalogError("SVD_ENDIAN_MISSING", "SVD must explicitly declare cpu.endian as little or big");
  const deviceSize = optionalWidth(root);
  const deviceAccess = optionalAccess(root);
  const peripheralsNode = requiredChild(root, "peripherals");
  const registers: SvdRegister[] = [];
  for (const peripheralNode of children(peripheralsNode, "peripheral")) {
    rejectUnsupportedNode(peripheralNode, "peripheral");
    const peripheral = requiredText(peripheralNode, "name");
    validateName(peripheral, "peripheral");
    const baseAddress = requiredNumber(peripheralNode, "baseAddress");
    const peripheralSize = optionalWidth(peripheralNode) ?? deviceSize;
    const peripheralAccess = optionalAccess(peripheralNode) ?? deviceAccess;
    if (children(peripheralNode, "clusters").length || children(peripheralNode, "cluster").length) throw new SvdCatalogError("SVD_LAYOUT_UNSUPPORTED", `clusters are unsupported in ${peripheral}`);
    const registersNode = child(peripheralNode, "registers");
    if (!registersNode) continue;
    for (const registerNode of children(registersNode, "register")) {
      registers.push(parseRegister(peripheral, baseAddress, peripheralSize, peripheralAccess, registerNode));
    }
  }
  if (registers.length === 0) throw new SvdCatalogError("SVD_FORMAT_INVALID", "SVD contains no explicit registers");
  return new SvdCatalog(path, sha256, endianText, registers);
}

export function assertRegisterReadable(resolved: SvdResolvedSelector): void {
  const { register, field } = resolved;
  if (!isReadable(register.access) || field?.access !== undefined && !isReadable(field.access)) {
    throw new SvdCatalogError("SVD_READ_NOT_ALLOWED", `${resolved.selector} is not declared readable`);
  }
  if (register.readAction || field?.readAction) throw new SvdCatalogError("SVD_READ_ACTION_UNSAFE", `${resolved.selector} declares destructive or state-changing readAction semantics`);
  const destructiveSibling = register.fields.find((candidate) => candidate.readAction);
  if (destructiveSibling) {
    throw new SvdCatalogError("SVD_READ_ACTION_UNSAFE", `${resolved.selector} requires a whole-register read, but ${register.selector}.${destructiveSibling.name} declares readAction semantics`);
  }
}

export function assertWholeRegisterWriteSafe(resolved: SvdResolvedSelector, value: number): void {
  const { register } = resolved;
  if (resolved.field) throw new SvdCatalogError("SVD_SELECTOR_INVALID", "whole-register write validation received a field selector");
  assertWritableSemantics(register.access, register.readAction, register.modifiedWriteValues, resolved.selector);
  for (const field of register.fields) {
    assertWritableSemantics(field.access ?? register.access, field.readAction ?? register.readAction, field.modifiedWriteValues ?? register.modifiedWriteValues, `${resolved.selector}.${field.name}`);
  }
  const limit = widthMask(register.width);
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new SvdCatalogError("SVD_VALUE_OUT_OF_RANGE", `value does not fit ${register.width} bits`);
  if (register.reservedMask !== 0) {
    if (register.resetValue === undefined) throw new SvdCatalogError("SVD_RESERVED_BITS_UNKNOWN", `${resolved.selector} has reserved bits without a reset value`);
    if ((value & register.reservedMask) !== (register.resetValue & register.reservedMask)) {
      throw new SvdCatalogError("SVD_RESERVED_BITS_UNSAFE", `${resolved.selector} would write non-reset values to reserved bits`);
    }
  }
}

export function assertFieldWriteSafe(resolved: SvdResolvedSelector, value: number): { mask: number; shiftedValue: number } {
  const { register, field } = resolved;
  if (!field) throw new SvdCatalogError("SVD_SELECTOR_INVALID", "field write requires PERIPHERAL.REGISTER.FIELD");
  if (!isReadable(register.access) || !isReadable(field.access ?? register.access) || register.readAction) {
    throw new SvdCatalogError("SVD_RMW_UNSAFE", `${register.selector} cannot be safely read for read-modify-write`);
  }
  const destructiveRead = register.fields.find((candidate) => candidate.readAction);
  if (destructiveRead) throw new SvdCatalogError("SVD_RMW_UNSAFE", `${register.selector} read-modify-write would trigger readAction on ${destructiveRead.name}`);
  const specialWrite = register.fields.find((candidate) => candidate.modifiedWriteValues && candidate.modifiedWriteValues !== "modify");
  if (specialWrite) throw new SvdCatalogError("SVD_MODIFIED_WRITE_UNSUPPORTED", `${register.selector} read-modify-write would apply unsupported ${specialWrite.modifiedWriteValues} semantics on ${specialWrite.name}`);
  const unsafeAccess = register.fields.find((candidate) => candidate !== field && ["write-only", "writeOnce", "read-writeOnce"].includes(candidate.access ?? register.access ?? ""));
  if (unsafeAccess) throw new SvdCatalogError("SVD_RMW_UNSAFE", `${register.selector} read-modify-write cannot safely preserve ${unsafeAccess.name} with ${unsafeAccess.access} access`);
  assertWritableSemantics(register.access, register.readAction, register.modifiedWriteValues, register.selector);
  assertWritableSemantics(field.access ?? register.access, field.readAction ?? register.readAction, field.modifiedWriteValues ?? register.modifiedWriteValues, resolved.selector);
  const limit = field.width === 32 ? 0xffff_ffff : 2 ** field.width - 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new SvdCatalogError("SVD_VALUE_OUT_OF_RANGE", `field value does not fit ${field.width} bits`);
  return { mask: field.mask, shiftedValue: (value * 2 ** field.lsb) >>> 0 };
}

function parseRegister(peripheral: string, baseAddress: number, inheritedSize: 8 | 16 | 32 | undefined, inheritedAccess: SvdAccess | undefined, node: XmlNode): SvdRegister {
  rejectUnsupportedNode(node, "register");
  const name = requiredText(node, "name");
  validateName(name, "register");
  const addressOffset = requiredNumber(node, "addressOffset");
  const width = optionalWidth(node) ?? inheritedSize;
  if (!width) throw new SvdCatalogError("SVD_WIDTH_MISSING", `${peripheral}.${name} has no inherited or explicit size`);
  const access = optionalAccess(node) ?? inheritedAccess;
  const address = baseAddress + addressOffset;
  if (!Number.isSafeInteger(address) || address < 0 || address + width / 8 > 0x1_0000_0000 || address % (width / 8) !== 0) {
    throw new SvdCatalogError("SVD_ADDRESS_INVALID", `${peripheral}.${name} has an invalid or unaligned address`);
  }
  const resetValue = optionalNumber(node, "resetValue");
  const resetMask = optionalNumber(node, "resetMask");
  const limit = widthMask(width);
  if (resetValue !== undefined && resetValue > limit || resetMask !== undefined && resetMask > limit) throw new SvdCatalogError("SVD_RESET_VALUE_INVALID", `${peripheral}.${name} reset metadata exceeds its width`);
  const fieldsNode = child(node, "fields");
  const fields = fieldsNode ? children(fieldsNode, "field").map((field) => parseField(peripheral, name, width, access, field)) : [];
  const fieldNames = new Set<string>();
  let used = 0n;
  for (const field of fields) {
    if (fieldNames.has(field.name)) throw new SvdCatalogError("SVD_FIELD_DUPLICATE", `${peripheral}.${name} contains duplicate field ${field.name}`);
    fieldNames.add(field.name);
    const mask = BigInt(field.mask >>> 0);
    if ((used & mask) !== 0n) throw new SvdCatalogError("SVD_FIELD_OVERLAP", `${peripheral}.${name} contains overlapping fields`);
    used |= mask;
  }
  const implemented = fields.length ? Number(used & 0xffff_ffffn) >>> 0 : resetMask;
  const reservedMask = implemented === undefined ? widthMask(width) : (widthMask(width) & (~implemented >>> 0)) >>> 0;
  return {
    peripheral,
    name,
    selector: `${peripheral}.${name}`,
    address,
    width,
    access,
    readAction: optionalText(node, "readAction"),
    modifiedWriteValues: optionalText(node, "modifiedWriteValues"),
    resetValue,
    resetMask,
    reservedMask,
    fields,
  };
}

function parseField(peripheral: string, register: string, registerWidth: number, inheritedAccess: SvdAccess | undefined, node: XmlNode): SvdField {
  rejectUnsupportedNode(node, "field");
  const name = requiredText(node, "name");
  validateName(name, "field");
  const candidates: Array<{ lsb: number; width: number }> = [];
  const bitOffset = optionalNumber(node, "bitOffset");
  const bitWidth = optionalNumber(node, "bitWidth");
  if (bitOffset !== undefined || bitWidth !== undefined) {
    if (bitOffset === undefined || bitWidth === undefined) throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} has an incomplete bitOffset/bitWidth pair`);
    candidates.push({ lsb: bitOffset, width: bitWidth });
  }
  const lsb = optionalNumber(node, "lsb");
  const msb = optionalNumber(node, "msb");
  if (lsb !== undefined || msb !== undefined) {
    if (lsb === undefined || msb === undefined || msb < lsb) throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} has an invalid lsb/msb pair`);
    candidates.push({ lsb, width: msb - lsb + 1 });
  }
  const bitRangeText = optionalText(node, "bitRange");
  const bitRange = bitRangeText?.match(/^\[(\d+):(\d+)\]$/);
  if (bitRangeText !== undefined && !bitRange) {
    throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} has a malformed bitRange`);
  }
  if (bitRange) {
    const high = Number(bitRange[1]);
    const low = Number(bitRange[2]);
    if (high < low) throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} has an invalid bitRange`);
    candidates.push({ lsb: low, width: high - low + 1 });
  }
  if (candidates.length === 0 || candidates.some((candidate) => candidate.lsb !== candidates[0].lsb || candidate.width !== candidates[0].width)) {
    throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} has missing or conflicting bit layout`);
  }
  const layout = candidates[0];
  if (!Number.isSafeInteger(layout.lsb) || !Number.isSafeInteger(layout.width) || layout.lsb < 0 || layout.width < 1 || layout.lsb + layout.width > registerWidth) {
    throw new SvdCatalogError("SVD_FIELD_LAYOUT_INVALID", `${peripheral}.${register}.${name} exceeds its register width`);
  }
  const mask = layout.width === 32 ? 0xffff_ffff : ((2 ** layout.width - 1) * 2 ** layout.lsb) >>> 0;
  return {
    name,
    lsb: layout.lsb,
    width: layout.width,
    mask,
    access: optionalAccess(node) ?? inheritedAccess,
    readAction: optionalText(node, "readAction"),
    modifiedWriteValues: optionalText(node, "modifiedWriteValues"),
  };
}

function assertWritableSemantics(access: SvdAccess | undefined, readAction: string | undefined, modifiedWriteValues: string | undefined, selector: string): void {
  if (!isWritable(access)) throw new SvdCatalogError("SVD_WRITE_NOT_ALLOWED", `${selector} is not declared writable`);
  if (readAction) throw new SvdCatalogError("SVD_READ_ACTION_UNSAFE", `${selector} declares readAction semantics`);
  if (modifiedWriteValues && modifiedWriteValues !== "modify") throw new SvdCatalogError("SVD_MODIFIED_WRITE_UNSUPPORTED", `${selector} declares unsupported ${modifiedWriteValues} semantics`);
}

function isReadable(access: SvdAccess | undefined): boolean {
  return access === "read-only" || access === "read-write" || access === "read-writeOnce";
}

function isWritable(access: SvdAccess | undefined): boolean {
  return access === "write-only" || access === "read-write";
}

function widthMask(width: number): number {
  return width === 32 ? 0xffff_ffff : 2 ** width - 1;
}

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SvdCatalogError("SVD_XML_UNSAFE", "DOCTYPE and custom entities are forbidden");
  const tokenPattern = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)([^>]*)>|([^<]+)/g;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let cursor = 0;
  for (const match of xml.matchAll(tokenPattern)) {
    if (match.index !== cursor && xml.slice(cursor, match.index).trim()) throw new SvdCatalogError("SVD_XML_INVALID", "SVD contains malformed XML tokens");
    cursor = match.index! + match[0].length;
    if (match[0].startsWith("<?") || match[0].startsWith("<!--")) continue;
    if (match[1] !== undefined) {
      if (!stack.length) throw new SvdCatalogError("SVD_XML_INVALID", "CDATA appears outside the document root");
      stack.at(-1)!.text += match[1];
      continue;
    }
    if (match[2]) {
      const current = stack.pop();
      if (!current || current.name !== localName(match[2])) throw new SvdCatalogError("SVD_XML_INVALID", `unexpected closing tag ${match[2]}`);
      continue;
    }
    if (match[3]) {
      const rawAttributes = match[4] ?? "";
      const selfClosing = /\/\s*$/.test(rawAttributes);
      const node: XmlNode = { name: localName(match[3]), attributes: parseAttributes(rawAttributes.replace(/\/\s*$/, "")), children: [], text: "" };
      if (stack.length) stack.at(-1)!.children.push(node);
      else if (root) throw new SvdCatalogError("SVD_XML_INVALID", "SVD contains more than one root element");
      else root = node;
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (match[5] !== undefined) {
      if (stack.length) stack.at(-1)!.text += decodeXml(match[5]);
      else if (match[5].trim()) throw new SvdCatalogError("SVD_XML_INVALID", "SVD contains text outside the document root");
    }
  }
  if (cursor !== xml.length && xml.slice(cursor).trim()) throw new SvdCatalogError("SVD_XML_INVALID", "SVD contains trailing malformed XML");
  if (!root || stack.length) throw new SvdCatalogError("SVD_XML_INVALID", "SVD XML is empty or unbalanced");
  return root;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;
  const pattern = /\s*([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  for (;;) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) break;
    const name = localName(match[1]);
    if (Object.hasOwn(attributes, name)) throw new SvdCatalogError("SVD_XML_INVALID", `SVD contains duplicate attribute ${name}`);
    attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
    cursor = pattern.lastIndex;
  }
  if (source.slice(cursor).trim()) throw new SvdCatalogError("SVD_XML_INVALID", "SVD contains malformed attributes");
  return attributes;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, entity: string) => {
    if (entity.toLowerCase() === "amp") return "&";
    if (entity.toLowerCase() === "lt") return "<";
    if (entity.toLowerCase() === "gt") return ">";
    if (entity.toLowerCase() === "quot") return '"';
    if (entity.toLowerCase() === "apos") return "'";
    const code = entity.toLowerCase().startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  }).replace(/&[^;\s]+;/g, () => { throw new SvdCatalogError("SVD_XML_UNSAFE", "unknown XML entity"); });
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((candidate) => candidate.name === name);
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  const matches = children(node, name);
  if (matches.length > 1) throw new SvdCatalogError("SVD_LAYOUT_CONFLICT", `<${node.name}> contains duplicate <${name}> values`);
  return matches[0];
}

function requiredChild(node: XmlNode, name: string): XmlNode {
  const value = child(node, name);
  if (!value) throw new SvdCatalogError("SVD_FORMAT_INVALID", `<${node.name}> requires <${name}>`);
  return value;
}

function optionalText(node: XmlNode, name: string): string | undefined {
  const value = child(node, name)?.text.trim();
  return value || undefined;
}

function requiredText(node: XmlNode, name: string): string {
  const value = optionalText(node, name);
  if (!value) throw new SvdCatalogError("SVD_FORMAT_INVALID", `<${node.name}> requires non-empty <${name}>`);
  return value;
}

function optionalNumber(node: XmlNode, name: string): number | undefined {
  const value = optionalText(node, name);
  return value === undefined ? undefined : parseSvdNumber(value, `${node.name}.${name}`);
}

function requiredNumber(node: XmlNode, name: string): number {
  const value = optionalNumber(node, name);
  if (value === undefined) throw new SvdCatalogError("SVD_FORMAT_INVALID", `<${node.name}> requires <${name}>`);
  return value;
}

function parseSvdNumber(value: string, name: string): number {
  const normalized = value.replace(/[_']/g, "").replace(/[uUlL]+$/, "");
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(normalized)) parsed = Number.parseInt(normalized.slice(2), 16);
  else if (/^0b[01]+$/i.test(normalized)) parsed = Number.parseInt(normalized.slice(2), 2);
  else if (/^#(?:[01x])+$/i.test(normalized) && !/x/i.test(normalized)) parsed = Number.parseInt(normalized.slice(1), 2);
  else if (/^\d+$/.test(normalized)) parsed = Number.parseInt(normalized, 10);
  else throw new SvdCatalogError("SVD_NUMBER_INVALID", `${name} is not a concrete integer: ${value}`);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) throw new SvdCatalogError("SVD_NUMBER_INVALID", `${name} is outside the unsigned 32-bit range`);
  return parsed;
}

function optionalWidth(node: XmlNode): 8 | 16 | 32 | undefined {
  const size = optionalNumber(node, "size");
  if (size === undefined) return undefined;
  if (size !== 8 && size !== 16 && size !== 32) throw new SvdCatalogError("SVD_WIDTH_UNSUPPORTED", `${node.name}.size must be 8, 16, or 32`);
  return size;
}

function optionalAccess(node: XmlNode): SvdAccess | undefined {
  const access = optionalText(node, "access");
  if (access === undefined) return undefined;
  if (!["read-only", "write-only", "read-write", "writeOnce", "read-writeOnce"].includes(access)) throw new SvdCatalogError("SVD_ACCESS_UNSUPPORTED", `unsupported SVD access: ${access}`);
  return access as SvdAccess;
}

function validateName(name: string, kind: string): void {
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new SvdCatalogError("SVD_NAME_UNSUPPORTED", `${kind} name is not a concrete selector token: ${name}`);
}

function rejectUnsupportedNode(node: XmlNode, kind: string): void {
  if (node.attributes.derivedFrom) throw new SvdCatalogError("SVD_DERIVED_UNSUPPORTED", `${kind} derivedFrom is unsupported`);
  if (child(node, "dim") || child(node, "dimIndex") || child(node, "dimIncrement")) throw new SvdCatalogError("SVD_DIM_UNSUPPORTED", `${kind} arrays are unsupported`);
}
