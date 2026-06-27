import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { crc16Ccitt, encodeTraceAgentWriteCommand, frameHex } from "./traceagent-codec";
import { decodeTraceAgentStream, parseTraceAgentAck, traceAgentStreamToExperiment } from "./traceagent-decoder";
import { hmC095TraceAgentPolicy, traceagentWriteSignal, validateTraceAgentWrite } from "./traceagent-tools";

test("TraceAgent encode reproduces HM_C095 guwWdgFlg write frames", () => {
  assert.equal(frameHex(encodeTraceAgentWriteCommand({ cmdId: 3, signalId: 13, value: 1 })), "AA 55 01 04 08 00 03 00 00 00 03 00 0D 00 01 00 00 00 EA 47");
  assert.equal(frameHex(encodeTraceAgentWriteCommand({ cmdId: 4, signalId: 13, value: 0 })), "AA 55 01 04 08 00 04 00 00 00 04 00 0D 00 00 00 00 00 0D FE");
});

test("TraceAgent write policy rejects unsafe values and dangerous variables before hardware send", () => {
  assert.equal(validateTraceAgentWrite(hmC095TraceAgentPolicy, "guwWdgFlg", 2), "value outside allowlist");
  assert.equal(validateTraceAgentWrite(hmC095TraceAgentPolicy, "other", 1), "signal is not allowlisted");
  assert.equal(validateTraceAgentWrite(hmC095TraceAgentPolicy, "guwWdgFlg", 0.5), "value must be an integer");
  assert.equal(validateTraceAgentWrite(hmC095TraceAgentPolicy, "bMotorStarted", 1), "dangerous variable rejected before hardware send");
  assert.equal(validateTraceAgentWrite(hmC095TraceAgentPolicy, "AppMotorDbg.c::gstMotorDbg.foo", 1), "dangerous variable rejected before hardware send");
});

test("TraceAgent ACK_OK, ACK_REJECT, and readback mismatch are handled", async () => {
  const unavailable = await traceagentWriteSignal({ signal: "guwWdgFlg", value: 1, cmdId: 6 });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.reason ?? "", /transport not configured/);

  const noAck = await traceagentWriteSignal({ signal: "guwWdgFlg", value: 1, cmdId: 6, transport: { write() {} } });
  assert.equal(noAck.status, "unavailable");
  assert.match(noAck.reason ?? "", /ACK transport/);

  const okAck = ackFrame(7, 0, 13, 1);
  assert.equal(parseTraceAgentAck(okAck).status, 0);
  const ok = await traceagentWriteSignal({
    signal: "guwWdgFlg",
    value: 1,
    cmdId: 7,
    transport: { write() {}, readAck() { return okAck; } },
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.readback, 1);

  const rejected = await traceagentWriteSignal({
    signal: "guwWdgFlg",
    value: 1,
    cmdId: 8,
    transport: { write() {}, readAck() { return ackFrame(8, 2, 13, 1); } },
  });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.reason ?? "", /status 2/);

  const mismatch = await traceagentWriteSignal({
    signal: "guwWdgFlg",
    value: 1,
    cmdId: 9,
    transport: { write() {}, readAck() { return ackFrame(9, 0, 13, 0); } },
  });
  assert.equal(mismatch.status, "rejected");
  assert.match(mismatch.reason ?? "", /readback mismatch/);
});

test("TraceAgent stream decoder detects CRC failures, gaps, duplicates, and discarded bytes", () => {
  assert.equal(decodeTraceAgentStream(Buffer.alloc(0)).frames, 0);
  assert.equal(decodeTraceAgentStream(Buffer.from([0xaa, 0x55, 0x02, 0x01, 0, 0, 0, 0])).invalidFrames, 1);
  assert.equal(decodeTraceAgentStream(Buffer.from([0xaa, 0x55, 0x01, 0x01, 0, 0, 0, 0])).discardedBytes, 8);
  assert.throws(() => parseTraceAgentAck(Buffer.alloc(2)), /too short/);

  const good1 = sampleFrame(1, 1000, [[0, 1]]);
  const good3 = sampleFrame(3, 3000, [[0, 3]]);
  const dup3 = sampleFrame(3, 4000, [[0, 3]]);
  const bad = Buffer.from(sampleFrame(4, 5000, [[0, 4]]));
  bad[20] ^= 0xff;
  const decoded = decodeTraceAgentStream(Buffer.concat([Buffer.from([0x00]), good1, good3, dup3, bad]));
  assert.equal(decoded.sampleFrames, 3);
  assert.equal(decoded.sequenceGaps, 1);
  assert.equal(decoded.duplicateSeqs, 1);
  assert.equal(decoded.crcFailures, 1);
  assert.equal(decoded.discardedBytes, 1);
});

test("TraceAgent decoder parses current HM_C095 direct RTT stream without CRC or sequence loss", async () => {
  const bytes = await readFile(join(process.cwd(), "reports", "hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin"));
  const decoded = decodeTraceAgentStream(bytes);
  assert.equal(decoded.frames, 1240);
  assert.equal(decoded.sampleFrames, 1240);
  assert.equal(decoded.crcFailures, 0);
  assert.equal(decoded.sequenceGaps, 0);
  assert.equal(decoded.duplicateSeqs, 0);
  assert.equal(decoded.discardedBytes, 0);

  const experiment = traceAgentStreamToExperiment({
    decoded,
    experimentId: "hm_c095_test",
    target: { device: "Z20K146MC" },
    backend: "direct-rtt-channel",
    signals: [
      { id: 0, name: "alive_counter", selector: "TRACE_SIGNAL_ALIVE_COUNTER", type: "uint32", role: "counter" },
      { id: 1, name: "os_tick", selector: "TRACE_SIGNAL_OS_TICK", type: "uint32", role: "timestamp" },
      { id: 4, name: "theta_rad", selector: "TRACE_SIGNAL_THETA_RAD", type: "float32", role: "raw" },
    ],
  });
  assert.equal(experiment.target!.device, "Z20K146MC");
  assert.equal(experiment.capture!.backend, "direct-rtt-channel");
  assert.equal(experiment.samples!.length, 1240);
  assert.ok((experiment.capture!.actualRateHz ?? 0) >= 45);

  const empty = traceAgentStreamToExperiment({
    decoded: decodeTraceAgentStream(Buffer.alloc(0)),
    experimentId: "empty",
    target: {},
    backend: "direct-rtt-channel",
    signals: [],
  });
  assert.equal(empty.capture!.actualRateHz, 0);
  assert.deepEqual(empty.timeWindowMs, [0, 0]);
});

function ackFrame(cmdId: number, status: number, signalId: number, readback: number): Buffer {
  const frame = encodeTraceAgentWriteCommand({ cmdId, signalId, value: readback });
  frame.writeUInt16LE(status, 10);
  frame.writeUInt16LE(crc16Ccitt(frame.subarray(2, 18)), 18);
  return frame;
}

function sampleFrame(sequence: number, timeUs: number, pairs: Array<[number, number]>): Buffer {
  const frame = Buffer.alloc(18 + pairs.length * 6 + 2);
  frame[0] = 0xaa;
  frame[1] = 0x55;
  frame[2] = 1;
  frame[3] = 1;
  frame.writeUInt16LE(8 + pairs.length * 6, 4);
  frame.writeUInt32LE(sequence, 6);
  frame.writeUInt32LE(timeUs, 10);
  frame.writeUInt16LE(0, 14);
  frame.writeUInt16LE(pairs.length, 16);
  let offset = 18;
  for (const [signalId, value] of pairs) {
    frame.writeUInt16LE(signalId, offset);
    frame.writeUInt32LE(value, offset + 2);
    offset += 6;
  }
  frame.writeUInt16LE(crc16Ccitt(frame.subarray(2, offset)), offset);
  return frame;
}
