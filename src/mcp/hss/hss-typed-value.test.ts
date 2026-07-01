import assert from "node:assert/strict";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { decodeHssValue, decodeHssValues, encodeHssValue, encodeHssValues, hssBytesEqual } from "./hss-typed-value";

test("typed values encode integer min/max ranges", () => {
  assert.equal(decodeHssValue("int8", encodeHssValue("int8", -128, "little"), "little"), -128);
  assert.equal(decodeHssValue("int8", encodeHssValue("int8", 127, "little"), "little"), 127);
  assert.equal(decodeHssValue("int16", encodeHssValue("int16", -32768, "little"), "little"), -32768);
  assert.equal(decodeHssValue("int16", encodeHssValue("int16", 32767, "little"), "little"), 32767);
  assert.equal(decodeHssValue("int32", encodeHssValue("int32", -2147483648, "little"), "little"), -2147483648);
  assert.equal(decodeHssValue("int32", encodeHssValue("int32", 2147483647, "little"), "little"), 2147483647);
});

test("typed values encode unsigned ranges and reject negatives", () => {
  assert.equal(decodeHssValue("uint8", encodeHssValue("uint8", 255, "little"), "little"), 255);
  assert.equal(decodeHssValue("uint16", encodeHssValue("uint16", 65535, "little"), "little"), 65535);
  assert.equal(decodeHssValue("uint32", encodeHssValue("uint32", 4294967295, "little"), "little"), 4294967295);
  assertValueError(() => encodeHssValue("uint8", -1, "little"));
});

test("typed values reject float NaN and Inf and preserve finite float32 bytes", () => {
  assertValueError(() => encodeHssValue("float32", Number.NaN, "little"));
  assertValueError(() => encodeHssValue("float32", Number.POSITIVE_INFINITY, "little"));
  const bytes = encodeHssValue("float32", 1.25, "little");
  assert.equal(decodeHssValue("float32", bytes, "little"), 1.25);
  assert.equal(hssBytesEqual(bytes, Buffer.from([0x00, 0x00, 0xa0, 0x3f])), true);
});

test("typed values honor target endian", () => {
  assert.deepEqual([...encodeHssValue("uint16", 0x1234, "little")], [0x34, 0x12]);
  assert.deepEqual([...encodeHssValue("uint16", 0x1234, "big")], [0x12, 0x34]);
  assert.deepEqual([...encodeHssValue("uint32", 0x12345678, "little")], [0x78, 0x56, 0x34, 0x12]);
  assert.deepEqual([...encodeHssValue("uint32", 0x12345678, "big")], [0x12, 0x34, 0x56, 0x78]);
});

test("typed arrays encode and decode exact element counts", () => {
  const bytes = encodeHssValues("int16", [100, 120, 140, 160], "little");
  assert.equal(bytes.length, 8);
  assert.deepEqual(decodeHssValues("int16", bytes, "little"), [100, 120, 140, 160]);
  assert.throws(() => encodeHssValues("int16", [], "little"), policyError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED));
  assert.throws(() => decodeHssValues("int16", Buffer.from([1]), "little"), policyError(HSS_ERROR.POLICY_TYPE_MISMATCH));
});

function assertValueError(fn: () => unknown): void {
  assert.throws(fn, policyError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE));
}

function policyError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HssError && error.code === code;
}
