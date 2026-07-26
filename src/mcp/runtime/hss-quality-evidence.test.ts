import assert from "node:assert/strict";
import test from "node:test";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import { qualityEvidenceFrom, type PreparedQualityOracle } from "./hss-quality-evidence";

const oracle: PreparedQualityOracle = {
  logicalIdentity: "counter",
  expectedIncrement: 1,
  tolerance: 0,
  modulus: 0x1_0000_0000,
};

test("quality evidence preserves qualified J-Link counters and sanitized provenance", () => {
  const evidence = qualityEvidenceFrom({
    qualitySource: "jlink",
    qualityCountersValidated: true,
    durationValidated: true,
    missingSamples: 1,
    droppedSamples: 2,
    overflows: 3,
    readErrors: 4,
    timeouts: 5,
    actualRateHz: 900,
  }, undefined, undefined, 1_000, { helperVersion: "fixture" });

  assert.equal(evidence.status, "reported");
  assert.equal(evidence.source, "jlink");
  assert.deepEqual(evidence.counters, {
    missingSamples: 1,
    droppedSamples: 2,
    overflows: 3,
    readErrors: 4,
    timeouts: 5,
  });
  assert.deepEqual(evidence.provenance, {
    source: "jlink",
    countersValidated: true,
    actualRateHz: 900,
    readErrors: 4,
    helperVersion: "fixture",
  });
});

test("quality evidence distinguishes partial J-Link counters from no qualified source", () => {
  const partial = qualityEvidenceFrom({ readErrors: 2, durationValidated: false }, undefined, undefined, 1_000);
  assert.equal(partial.status, "partial");
  assert.equal(partial.source, "jlink");
  assert.equal(partial.counters.readErrors, 2);
  assert.equal(partial.durationValidated, false);

  const none = qualityEvidenceFrom(undefined, undefined, undefined, 1_000);
  assert.equal(none.status, "partial");
  assert.equal(none.source, "none");
  assert.deepEqual(none.provenance, { source: "none", reason: "no_qualified_quality_source" });
});

test("target counter quality reports unambiguous missing frames", () => {
  const evidence = qualityEvidenceFrom(
    { durationValidated: true },
    {
      samples: [
        { sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, values: { counter: 10 } },
        { sampleIndex: 1, tick: "1000000", statusFlags: HSS_STATUS_FLAGS.valid, values: { counter: 12 } },
      ],
      events: [],
    },
    oracle,
    1_000,
  );

  assert.equal(evidence.status, "reported");
  assert.equal(evidence.source, "target_counter");
  assert.equal(evidence.counters.missingSamples, 1);
  assert.deepEqual(evidence.inferredDroppedBeforeSampleIndexes, [1]);
});

test("target counter quality remains partial across write intervals and invalid samples", () => {
  const evidence = qualityEvidenceFrom(
    { durationValidated: true },
    {
      samples: [
        { sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, values: { counter: 10 } },
        { sampleIndex: 1, tick: "1000000", statusFlags: HSS_STATUS_FLAGS.valid, values: { counter: 11 } },
        { sampleIndex: 2, tick: "2000000", statusFlags: HSS_STATUS_FLAGS.read_error, values: { counter: 12 } },
      ],
      events: [{
        type: "variable_write",
        tick: "500000",
        logicalIdentity: "counter",
        operationStartTick: "400000",
        operationEndTick: "600000",
      }],
    },
    oracle,
    1_000,
  );

  assert.equal(evidence.status, "partial");
  assert.equal(evidence.source, "target_counter");
  assert.deepEqual((evidence.provenance.diagnostics as string[]), ["invalid_sample", "write_interval"]);
  assert.deepEqual(evidence.inferredDroppedBeforeSampleIndexes, []);
});
