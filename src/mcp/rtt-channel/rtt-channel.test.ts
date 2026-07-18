import assert from "node:assert/strict";
import test from "node:test";
import { findRttChannel, listRttChannels, requireRttChannel } from "./rtt-control-block";
import { readRttRing, writeRttRing } from "./rtt-ring-buffer";
import { rttChannelListTool, rttChannelReadTool, rttChannelWriteTool } from "./rtt-channel-tools";

const snapshot = {
  controlBlockAddress: "0x2000657C",
  upChannels: [{ index: 1, name: "AI_TRACE", direction: "up" as const, size: 1024 }],
  downChannels: [{ index: 1, name: "AI_CMD", direction: "down" as const, size: 64 }],
};

test("RTT channel discovery handles no control block, channel by name, and channel by index", () => {
  assert.equal(listRttChannels({ upChannels: [], downChannels: [] }).status, "unavailable");
  assert.equal(findRttChannel(snapshot.upChannels, "AI_TRACE")?.index, 1);
  assert.equal(requireRttChannel(snapshot, "down", 1).name, "AI_CMD");
  assert.throws(() => requireRttChannel(snapshot, "up", "missing"), /requested RTT channel not found/);
});

test("RTT ring read handles no-wrap and wrap-around with offset update", () => {
  const noWrap = readRttRing({ buffer: Uint8Array.from([0, 1, 2, 3, 4]), rdOff: 1, wrOff: 4 });
  assert.deepEqual([...noWrap.data], [1, 2, 3]);
  assert.equal(noWrap.nextRdOff, 4);

  const wrap = readRttRing({ buffer: Uint8Array.from([8, 9, 0, 0, 7]), rdOff: 4, wrOff: 2 });
  assert.deepEqual([...wrap.data], [7, 8, 9]);
  assert.equal(wrap.nextRdOff, 2);
});

test("RTT ring write handles no-wrap, wrap-around, and insufficient space", () => {
  const noWrap = writeRttRing({ buffer: new Uint8Array(6), rdOff: 0, wrOff: 1 }, Uint8Array.from([1, 2, 3]));
  assert.equal(noWrap.ok, true);
  assert.equal(noWrap.nextWrOff, 4);
  assert.deepEqual([...noWrap.buffer], [0, 1, 2, 3, 0, 0]);

  const wrap = writeRttRing({ buffer: new Uint8Array(6), rdOff: 3, wrOff: 4 }, Uint8Array.from([8, 9, 10, 11]));
  assert.equal(wrap.ok, true);
  assert.equal(wrap.nextWrOff, 2);
  assert.deepEqual([...wrap.buffer], [10, 11, 0, 0, 8, 9]);

  const full = writeRttRing({ buffer: new Uint8Array(4), rdOff: 1, wrOff: 0 }, Uint8Array.from([1, 2]));
  assert.equal(full.ok, false);
  assert.equal(full.reason, "insufficient down buffer space");
});

test("RTT channel tool wrappers return structured read/write results", () => {
  assert.equal(rttChannelListTool(snapshot).channels.length, 2);
  const read = rttChannelReadTool({ snapshot, selector: "AI_TRACE", ring: { buffer: Uint8Array.from([0xaa, 0xbb, 0x00]), rdOff: 0, wrOff: 2 } });
  assert.equal(read.channel, 1);
  assert.equal(read.dataHex, "aabb");
  assert.equal(read.nextRdOff, 2);

  const write = rttChannelWriteTool({ snapshot, selector: "AI_CMD", ring: { buffer: new Uint8Array(4), rdOff: 0, wrOff: 1 }, data: Uint8Array.from([0xcc]) });
  assert.equal(write.ok, true);
  assert.equal(write.channel, 1);

  assert.throws(() => rttChannelReadTool({ snapshot, selector: "AI_TRACE" }), /transport not configured/);
  assert.throws(() => rttChannelWriteTool({ snapshot, selector: "AI_CMD", data: Uint8Array.from([0xcc]) }), /transport not configured/);
});
