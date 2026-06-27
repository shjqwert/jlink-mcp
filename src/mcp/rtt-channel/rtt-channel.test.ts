import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { findRttChannel, listRttChannels, requireRttChannel } from "./rtt-control-block";
import { parseRttRingAddresses, readDirectRttRing, writeDirectRttRing, type DirectRttMemoryIo } from "./direct-rtt-memory-transport";
import { RspMemoryIo } from "./rsp-memory-transport";
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

test("direct RTT memory transport reads, writes, and updates offsets", async () => {
  const memory = new Map<number, number>();
  const ring = parseRttRingAddresses({ bufferAddress: "0x1000", size: 6, rdOffAddress: "0x2000", wrOffAddress: "0x2004" });
  putBytes(memory, 0x1000, [0xaa, 0xbb, 0, 0, 0, 0]);
  putUInt32(memory, 0x2000, 0);
  putUInt32(memory, 0x2004, 2);
  const io = fakeIo(memory);

  const read = await readDirectRttRing(io, ring, 10);
  assert.equal(Buffer.from(read.data).toString("hex"), "aabb");
  assert.equal(read.nextRdOff, 2);
  assert.equal(getUInt32(memory, 0x2000), 2);

  putUInt32(memory, 0x2000, 2);
  putUInt32(memory, 0x2004, 4);
  const written = await writeDirectRttRing(io, ring, Uint8Array.from([0x11, 0x22, 0x33]));
  assert.equal(written.ok, true);
  assert.equal(written.nextWrOff, 1);
  assert.deepEqual([memory.get(0x1004), memory.get(0x1005), memory.get(0x1000)], [0x11, 0x22, 0x33]);
  assert.equal(getUInt32(memory, 0x2004), 1);

  assert.throws(() => parseRttRingAddresses({ bufferAddress: "bad", size: 6, rdOffAddress: "0x2000", wrOffAddress: "0x2004" }), /invalid address/);
  assert.throws(() => parseRttRingAddresses({ bufferAddress: "0x1000", size: 0, rdOffAddress: "0x2000", wrOffAddress: "0x2004" }), /RTT ring size/);
});

test("RSP memory IO reads and writes direct RTT rings over serialized m/M packets", async () => {
  const memory = new Map<number, number>();
  const ring = parseRttRingAddresses({ bufferAddress: "0x1000", size: 6, rdOffAddress: "0x2000", wrOffAddress: "0x2004" });
  putBytes(memory, 0x1000, [0xaa, 0xbb, 0, 0, 0, 0]);
  putUInt32(memory, 0x2000, 0);
  putUInt32(memory, 0x2004, 2);

  const server = createRspMemoryServer(memory);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP server address");

  const io = await RspMemoryIo.connect({ port: address.port, timeoutMs: 500 });
  try {
    const read = await readDirectRttRing(io, ring);
    assert.equal(Buffer.from(read.data).toString("hex"), "aabb");
    assert.equal(getUInt32(memory, 0x2000), 2);

    putUInt32(memory, 0x2000, 2);
    putUInt32(memory, 0x2004, 4);
    const written = await writeDirectRttRing(io, ring, Uint8Array.from([0x11, 0x22, 0x33]));
    assert.equal(written.ok, true);
    assert.deepEqual([memory.get(0x1004), memory.get(0x1005), memory.get(0x1000)], [0x11, 0x22, 0x33]);
    assert.equal(getUInt32(memory, 0x2004), 1);
  } finally {
    io.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("RSP memory IO handles monitor output and read errors", async () => {
  const server = createRspServer((payload) => {
    if (payload === "qSupported") return "";
    if (payload.startsWith("qRcmd,")) return [`O${Buffer.from("running\n", "utf8").toString("hex")}`, "OK"];
    if (payload.startsWith("m")) return "E02";
    return "E01";
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP server address");

  const io = await RspMemoryIo.connect({ port: address.port, timeoutMs: 500 });
  try {
    assert.equal(await io.monitor("go"), "running\n");
    await assert.rejects(() => io.readMemory(0x1000, 1), /RSP memory read failed: E02/);
  } finally {
    io.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("RSP memory IO rejects short reads and write failures", async () => {
  const server = createRspServer((payload) => {
    if (payload === "qSupported") return "";
    if (payload.startsWith("m")) return "00";
    if (payload.startsWith("M")) return "E03";
    return "E01";
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP server address");

  const io = await RspMemoryIo.connect({ port: address.port, timeoutMs: 500 });
  try {
    await assert.rejects(() => io.readMemory(0x1000, 2), /RSP memory read returned 1\/2 bytes/);
    await assert.rejects(() => io.writeByte(0x1000, 0x12), /RSP memory write failed: E03/);
  } finally {
    io.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function fakeIo(memory: Map<number, number>): DirectRttMemoryIo {
  return {
    async readMemory(address, length) {
      return Uint8Array.from(Array.from({ length }, (_, i) => memory.get(address + i) ?? 0));
    },
    async writeByte(address, value) {
      memory.set(address, value);
    },
    async writeUInt32(address, value) {
      putUInt32(memory, address, value);
    },
  };
}

function putBytes(memory: Map<number, number>, address: number, bytes: number[]): void {
  bytes.forEach((byte, index) => memory.set(address + index, byte));
}

function putUInt32(memory: Map<number, number>, address: number, value: number): void {
  putBytes(memory, address, [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function getUInt32(memory: Map<number, number>, address: number): number {
  return (memory.get(address) ?? 0) | ((memory.get(address + 1) ?? 0) << 8) | ((memory.get(address + 2) ?? 0) << 16) | ((memory.get(address + 3) ?? 0) << 24);
}

type RspResponse = string | string[];

function createRspMemoryServer(memory: Map<number, number>): net.Server {
  return createRspServer((payload) => handleRspPayload(memory, payload));
}

function createRspServer(handle: (payload: string) => RspResponse): net.Server {
  return net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (pending.length > 0) {
        const start = pending.indexOf(0x24);
        if (start < 0) {
          pending = Buffer.alloc(0);
          return;
        }
        if (start > 0) pending = pending.subarray(start);
        const end = pending.indexOf(0x23, 1);
        if (end < 0 || end + 2 >= pending.length) return;
        const payload = pending.subarray(1, end).toString("ascii");
        pending = pending.subarray(end + 3);
        socket.write("+");
        const responses = handle(payload);
        (Array.isArray(responses) ? responses : [responses]).forEach((response, index) => {
          const write = () => socket.write(rspPacket(response));
          if (index === 0) write();
          else setTimeout(write, index);
        });
      }
    });
  });
}

function handleRspPayload(memory: Map<number, number>, payload: string): string {
  if (payload === "qSupported") return "";
  if (payload.startsWith("qRcmd,")) return "OK";
  const read = payload.match(/^m([0-9a-fA-F]+),([0-9a-fA-F]+)$/);
  if (read) {
    const address = Number.parseInt(read[1], 16);
    const length = Number.parseInt(read[2], 16);
    return Buffer.from(Array.from({ length }, (_, index) => memory.get(address + index) ?? 0)).toString("hex");
  }
  const write = payload.match(/^M([0-9a-fA-F]+),([0-9a-fA-F]+):([0-9a-fA-F]*)$/);
  if (write) {
    const address = Number.parseInt(write[1], 16);
    const bytes = Buffer.from(write[3], "hex");
    bytes.forEach((byte, index) => memory.set(address + index, byte));
    return "OK";
  }
  return "E01";
}

function rspPacket(payload: string): string {
  const bytes = Buffer.from(payload, "ascii");
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return `$${payload}#${sum.toString(16).padStart(2, "0")}`;
}
