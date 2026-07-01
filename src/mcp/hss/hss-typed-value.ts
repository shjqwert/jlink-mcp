import { HSS_ERROR, HssError } from "./hss-errors";
import type { HssScalarType } from "./hss-contract";

export type HssTargetEndian = "little" | "big";

const TYPE_BYTES: Record<HssScalarType, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4 };
const INT_RANGE: Partial<Record<HssScalarType, { min: number; max: number }>> = {
  int8: { min: -128, max: 127 },
  uint8: { min: 0, max: 255 },
  int16: { min: -32768, max: 32767 },
  uint16: { min: 0, max: 65535 },
  int32: { min: -2147483648, max: 2147483647 },
  uint32: { min: 0, max: 4294967295 },
};

export function hssTypedByteSize(type: HssScalarType): number {
  return TYPE_BYTES[type];
}

export function encodeHssValue(type: HssScalarType, value: number, endian: HssTargetEndian): Buffer {
  validateEndian(endian);
  validateValue(type, value);
  const buffer = Buffer.alloc(TYPE_BYTES[type]);
  switch (type) {
    case "int8": buffer.writeInt8(value, 0); break;
    case "uint8": buffer.writeUInt8(value, 0); break;
    case "int16": endian === "little" ? buffer.writeInt16LE(value, 0) : buffer.writeInt16BE(value, 0); break;
    case "uint16": endian === "little" ? buffer.writeUInt16LE(value, 0) : buffer.writeUInt16BE(value, 0); break;
    case "int32": endian === "little" ? buffer.writeInt32LE(value, 0) : buffer.writeInt32BE(value, 0); break;
    case "uint32": endian === "little" ? buffer.writeUInt32LE(value, 0) : buffer.writeUInt32BE(value, 0); break;
    case "float32": endian === "little" ? buffer.writeFloatLE(value, 0) : buffer.writeFloatBE(value, 0); break;
  }
  return buffer;
}

export function decodeHssValue(type: HssScalarType, bytes: Buffer, endian: HssTargetEndian): number {
  validateEndian(endian);
  if (bytes.length !== TYPE_BYTES[type]) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "value byte length does not match scalar type", { type, byteLength: bytes.length });
  switch (type) {
    case "int8": return bytes.readInt8(0);
    case "uint8": return bytes.readUInt8(0);
    case "int16": return endian === "little" ? bytes.readInt16LE(0) : bytes.readInt16BE(0);
    case "uint16": return endian === "little" ? bytes.readUInt16LE(0) : bytes.readUInt16BE(0);
    case "int32": return endian === "little" ? bytes.readInt32LE(0) : bytes.readInt32BE(0);
    case "uint32": return endian === "little" ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
    case "float32": return endian === "little" ? bytes.readFloatLE(0) : bytes.readFloatBE(0);
  }
}

export function encodeHssValues(type: HssScalarType, values: number[], endian: HssTargetEndian): Buffer {
  if (values.length === 0) throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, "values must not be empty");
  return Buffer.concat(values.map((value) => encodeHssValue(type, value, endian)));
}

export function decodeHssValues(type: HssScalarType, bytes: Buffer, endian: HssTargetEndian): number[] {
  validateEndian(endian);
  const byteSize = TYPE_BYTES[type];
  if (bytes.length === 0 || bytes.length % byteSize !== 0) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "byte length must equal elementSize * elementCount", { type, byteLength: bytes.length });
  const values: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += byteSize) values.push(decodeHssValue(type, bytes.subarray(offset, offset + byteSize), endian));
  return values;
}

export function hssBytesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function validateValue(type: HssScalarType, value: number): void {
  if (!Number.isFinite(value)) throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, "value must be finite", { type, value });
  if (type === "float32") return;
  const range = INT_RANGE[type];
  if (!range || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, `value does not fit ${type}`, { type, value });
  }
}

function validateEndian(endian: HssTargetEndian): void {
  if (endian !== "little" && endian !== "big") throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "target endian must be little or big", { endian });
}
