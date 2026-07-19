import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertFieldWriteSafe,
  assertRegisterReadable,
  assertWholeRegisterWriteSafe,
  loadSvdCatalog,
  SvdCatalogError,
} from "./svd-catalog";

test("SVD catalog resolves exact registers and fields with inherited semantics", () => {
  const catalog = fixtureCatalog(validSvd());
  assert.equal(catalog.endian, "little");
  const field = catalog.resolve("GPIO.CTRL.MODE");
  assert.equal(field.register.address, 0x40000000);
  assert.equal(field.register.width, 32);
  assert.deepEqual(assertFieldWriteSafe(field, 3), { mask: 0x6, shiftedValue: 0x6 });
  assert.doesNotThrow(() => assertRegisterReadable(field));
  assert.doesNotThrow(() => assertWholeRegisterWriteSafe(catalog.resolve("GPIO.CTRL"), 5));
  assert.throws(() => assertWholeRegisterWriteSafe(catalog.resolve("GPIO.CTRL"), 0x80000000), errorCode("SVD_RESERVED_BITS_UNSAFE"));
  assert.throws(() => catalog.resolve("gpio.ctrl"), errorCode("SVD_SELECTOR_NOT_FOUND"));
});

test("SVD catalog rejects destructive reads and special modified-write semantics", () => {
  const catalog = fixtureCatalog(validSvd());
  assert.throws(() => assertRegisterReadable(catalog.resolve("GPIO.LATCH")), errorCode("SVD_READ_ACTION_UNSAFE"));
  assert.throws(() => assertFieldWriteSafe(catalog.resolve("GPIO.FLAGS.DONE"), 1), errorCode("SVD_MODIFIED_WRITE_UNSUPPORTED"));
  assert.throws(() => assertWholeRegisterWriteSafe(catalog.resolve("GPIO.STATUS"), 0), errorCode("SVD_WRITE_NOT_ALLOWED"));
});

test("SVD parser rejects unsafe XML, derived layouts, and overlapping fields", () => {
  assert.throws(() => fixtureCatalog(`<!DOCTYPE device [<!ENTITY x "y">]><device/>`), errorCode("SVD_XML_UNSAFE"));
  assert.throws(() => fixtureCatalog(validSvd().replace("<peripheral>", '<peripheral derivedFrom="OTHER">')), errorCode("SVD_DERIVED_UNSUPPORTED"));
  assert.throws(() => fixtureCatalog(validSvd().replace("<bitOffset>1</bitOffset><bitWidth>2</bitWidth>", "<bitOffset>0</bitOffset><bitWidth>2</bitWidth>")), errorCode("SVD_FIELD_OVERLAP"));
  assert.throws(() => fixtureCatalog(validSvd().replace("<bitOffset>1</bitOffset><bitWidth>2</bitWidth>", "<bitOffset>1</bitOffset><bitWidth>2</bitWidth><bitRange>[bad]</bitRange>")), errorCode("SVD_FIELD_LAYOUT_INVALID"));
  assert.throws(() => fixtureCatalog(validSvd().replace("<name>MODE</name><bitOffset>1</bitOffset><bitWidth>2</bitWidth>", "<name>ENABLE</name><bitOffset>1</bitOffset><bitWidth>2</bitWidth>")), errorCode("SVD_FIELD_DUPLICATE"));
  assert.throws(() => fixtureCatalog(`outside${validSvd()}`), errorCode("SVD_XML_INVALID"));
  assert.throws(() => fixtureCatalog(validSvd().replace("<device>", '<device version="1" version="2">')), errorCode("SVD_XML_INVALID"));
});

function fixtureCatalog(xml: string) {
  const root = mkdtempSync(join(tmpdir(), "jlink-svd-"));
  const file = join(root, "device.svd");
  writeFileSync(file, xml, "utf8");
  return loadSvdCatalog(file);
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof SvdCatalogError && error.code === code;
}

function validSvd(): string {
  return `<?xml version="1.0"?>
<device>
  <name>Fixture</name>
  <cpu><name>CM4</name><endian>little</endian></cpu>
  <size>32</size><access>read-write</access>
  <peripherals>
    <peripheral>
      <name>GPIO</name><baseAddress>0x40000000</baseAddress>
      <registers>
        <register>
          <name>CTRL</name><addressOffset>0</addressOffset><resetValue>0</resetValue><resetMask>0x7</resetMask>
          <fields>
            <field><name>ENABLE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>MODE</name><bitOffset>1</bitOffset><bitWidth>2</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>STATUS</name><addressOffset>4</addressOffset><access>read-only</access><resetValue>0</resetValue><resetMask>0xffffffff</resetMask>
        </register>
        <register>
          <name>LATCH</name><addressOffset>8</addressOffset><readAction>clear</readAction><resetValue>0</resetValue><resetMask>0xffffffff</resetMask>
        </register>
        <register>
          <name>FLAGS</name><addressOffset>12</addressOffset><resetValue>0</resetValue><resetMask>1</resetMask>
          <fields><field><name>DONE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>oneToClear</modifiedWriteValues></field></fields>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;
}
