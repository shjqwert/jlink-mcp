import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HssError } from "./hss-errors";
import { finalizeMetadata, readHssRecords, writeInitialMetadata } from "./hss-artifact";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";
import { createPredictableSemanticFixture } from "./predictable-semantic-fixture";

test("predictable counter fixture proves values, order, timebase, and dropped samples", async () => {
  const fixture = createPredictableSemanticFixture();
  const directory = await mkdtemp(join(tmpdir(), "jlink-hss-semantic-"));
  try {
    const file = join(directory, "counter.bin");
    await writeFile(file, fixture.bytes);
    const records = await readHssRecords(file, fixture.symbolCount, fixture.recordSize);

    assert.deepEqual(records.map((record) => ({
      sampleIndex: record.sampleIndex,
      timestampTicks: record.timestampTicks,
      statusFlags: record.statusFlags,
      counter: record.rawValues[0],
    })), fixture.expected);

    for (let index = 1; index < records.length; index += 1) {
      const sampleDelta = records[index].sampleIndex - records[index - 1].sampleIndex;
      assert.ok(sampleDelta > 0n);
      assert.ok(records[index].timestampTicks >= records[index - 1].timestampTicks);
      assert.equal(records[index].timestampTicks - records[index - 1].timestampTicks, sampleDelta * fixture.tickStepNs);
      assert.equal(records[index].rawValues[0] - records[index - 1].rawValues[0], Number(sampleDelta) * fixture.counterStep);
      assert.equal(
        (records[index].statusFlags & HSS_STATUS_FLAGS.dropped_before_this_sample) !== 0,
        sampleDelta > 1n,
      );
    }

    const metadataFile = join(directory, "capture.json");
    await writeInitialMetadata({
      metadataFile,
      captureId: "predictable-counter",
      sessionName: "semantic-fixture",
      projectRoot: directory,
      artifact: { file: "fixture.out", sha256: "0".repeat(64), resolver: "iar-map" },
      target: { device: "fixture", interface: "SWD", speedKhz: 1 },
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32", address: "0x20000000", size: 4, source: "iar-map" }],
      requestedRateHz: 4000,
    });
    const metadata = await finalizeMetadata({
      metadataFile,
      state: "completed",
      segmentFile: file,
      helperResult: {
        decoderSemanticsValidated: true,
        emittedSamples: records.length,
        duplicateSamples: 1,
        droppedSamples: 1,
        readErrors: 0,
      },
    });
    assert.equal(metadata.quality.sampleCount, 4);
    assert.equal(metadata.quality.droppedSamples, 1);
    assert.equal(metadata.quality.readErrors, 0);
    assert.equal(metadata.dataQualityStatus, "warning");
    assert.equal(metadata.semanticValidationStatus, "pass");
    assert.equal(metadata.hmC095?.counterMonotonic, true);
    assert.equal((metadata.events.at(-1)?.helperResult as Record<string, unknown>).duplicateSamples, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("decoder rejects invalid semantic record sequences", async () => {
  const fixture = createPredictableSemanticFixture();
  const directory = await mkdtemp(join(tmpdir(), "jlink-hss-semantic-invalid-"));
  const file = join(directory, "invalid.bin");
  const reject = async (bytes: Buffer, code: string, reason?: string) => {
    await writeFile(file, bytes);
    await assert.rejects(
      () => readHssRecords(file, fixture.symbolCount, fixture.recordSize),
      (error) => error instanceof HssError
        && String(error.code) === code
        && (reason === undefined || error.details.reason === reason),
    );
  };
  try {
    const duplicate = Buffer.from(fixture.bytes);
    duplicate.writeBigUInt64LE(40n, fixture.recordSize);
    await reject(duplicate, "HSS_SAMPLE_INDEX_INVALID", "duplicate");

    const decreasing = Buffer.from(fixture.bytes);
    decreasing.writeBigUInt64LE(39n, fixture.recordSize);
    await reject(decreasing, "HSS_SAMPLE_INDEX_INVALID", "decreasing");

    const timeRegression = Buffer.from(fixture.bytes);
    timeRegression.writeBigUInt64LE(1n, fixture.recordSize * 2 + 8);
    await reject(timeRegression, "HSS_TIMESTAMP_INVALID", "decreasing");

    const unmarkedGap = Buffer.from(fixture.bytes);
    unmarkedGap.writeUInt32LE(HSS_STATUS_FLAGS.valid, fixture.recordSize * 2 + 16);
    await reject(unmarkedGap, "HSS_SAMPLE_GAP_UNMARKED");

    await reject(fixture.bytes.subarray(0, fixture.bytes.length - 1), "HSS_RECORD_TRUNCATED");

    await writeFile(file, fixture.bytes);
    await assert.rejects(
      () => readHssRecords(file, fixture.symbolCount, fixture.recordSize - 1),
      (error) => error instanceof HssError && String(error.code) === "HSS_RECORD_SIZE_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
