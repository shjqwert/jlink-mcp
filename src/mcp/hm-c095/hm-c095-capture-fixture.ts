import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRepoTempDir } from "../preflight/temp-preflight";

export async function writeHmCapture(): Promise<{
  directory: string;
  metadataFile: string;
  binaryFile: string;
  metadata: ReturnType<typeof hmMetadata>;
}> {
  const directory = await createRepoTempDir("hm-c095-capture-");
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const prefix = `2026-06-27T00-00-00-000Z-${sessionId}`;
  const binaryFile = join(directory, `${prefix}.jlcp`);
  const metadataFile = join(directory, `${prefix}.metadata.json`);
  await writeFile(binaryFile, hmCaptureBinary());
  const metadata = hmMetadata(sessionId, binaryFile);
  await writeFile(metadataFile, JSON.stringify(metadata));
  return { directory, metadataFile, binaryFile, metadata };
}

export function hmMetadata(sessionId: string, binaryFile: string) {
  return {
    version: 1 as const,
    sessionId,
    state: "stopped" as const,
    elfPath: "D:\\HM_C095\\Appl\\Debug\\Exe\\FOC_SCM.out",
    elfSha256: "0".repeat(64),
    device: "Z20K146M",
    probeModel: "synthetic",
    probeSerial: "offline",
    swdRateKhz: 4000,
    gdbServerPath: "JLinkGDBServerCL.exe",
    gdbServerVersion: "synthetic",
    rspCapabilities: [],
    symbols: [
      { name: "AppMotorDbg.c::gstMotorDbg.fModPu", alias: "mod_pu", address: 0x20000000, size: 4, type: "float32" as const },
      { name: "AppMotorDbg.c::gstMotorDbg.fIuPu", alias: "iu_pu", address: 0x20000004, size: 4, type: "float32" as const },
      { name: "AppMotorDbg.c::gstMotorDbg.ucSector", alias: "sector", address: 0x20000008, size: 1, type: "uint8" as const },
      { name: "AppMotorDbg.c::gstMotorDbg.enFault", alias: "motor_fault", address: 0x2000000c, size: 4, type: "uint32" as const },
      { name: "TraceAgentPort.c::s_traceAliveCounter", alias: "alive_counter", address: 0x20000010, size: 4, type: "uint32" as const },
    ],
    timing: { actualRateHz: 100 },
    events: [],
    failures: [],
    resets: [],
    terminationReason: "synthetic",
    binaryFile,
  };
}

export function hmCaptureBinary(): Buffer {
  const header = Buffer.alloc(52);
  const symbolCount = 5;
  const frameCount = 5;
  header.write("JLCP", 0, "ascii");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(52, 8);
  header.writeBigInt64LE(1000n, 12);
  header.writeUInt32LE(symbolCount, 20);
  header.writeUInt32LE(184, 24);
  header.writeBigUInt64LE(BigInt(frameCount), 28);
  header.writeBigUInt64LE(0n, 36);
  header.writeUInt32LE(2, 44);

  const symbols = Buffer.alloc(464 * symbolCount);
  writeSymbol(symbols, 0, "AppMotorDbg.c::gstMotorDbg.fModPu", "mod_pu", 0x20000000n, 7, 4);
  writeSymbol(symbols, 464, "AppMotorDbg.c::gstMotorDbg.fIuPu", "iu_pu", 0x20000004n, 7, 4);
  writeSymbol(symbols, 928, "AppMotorDbg.c::gstMotorDbg.ucSector", "sector", 0x20000008n, 2, 1);
  writeSymbol(symbols, 1392, "AppMotorDbg.c::gstMotorDbg.enFault", "motor_fault", 0x2000000cn, 6, 4);
  writeSymbol(symbols, 1856, "TraceAgentPort.c::s_traceAliveCounter", "alive_counter", 0x20000010n, 6, 4);

  const frames = Buffer.alloc(184 * frameCount);
  const values = [
    [0, 0, 0, 0, 0],
    [0.3, 0.18, 1, 0, 1],
    [0.3, 0.42, 2, 0, 2],
    [0.3, 0.31, 2, 2, 2],
    [0.3, 0.3, 2, 2, 2],
  ];
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 184;
    const qpc = BigInt(index * 10);
    frames.writeBigUInt64LE(BigInt(index), offset);
    frames.writeBigInt64LE(qpc, offset + 8);
    frames.writeBigInt64LE(qpc, offset + 16);
    frames.writeBigInt64LE(qpc, offset + 24);
    frames.writeBigInt64LE(qpc, offset + 32);
    frames.writeBigInt64LE(1n, offset + 40);
    frames.writeUInt32LE(0, offset + 48);
    frames.writeUInt32LE(1, offset + 52);
    frames.writeUInt32LE(floatBits(values[index][0]), offset + 56);
    frames.writeUInt32LE(floatBits(values[index][1]), offset + 60);
    frames.writeUInt32LE(values[index][2], offset + 64);
    frames.writeUInt32LE(values[index][3], offset + 68);
    frames.writeUInt32LE(values[index][4], offset + 72);
  }
  return Buffer.concat([header, symbols, frames]);
}

function writeSymbol(buffer: Buffer, offset: number, name: string, alias: string, address: bigint, type: number, size: number): void {
  buffer.write(name, offset, "utf8");
  buffer.write(alias, offset + 256, "utf8");
  buffer.writeBigUInt64LE(address, offset + 448);
  buffer.writeUInt32LE(size, offset + 456);
  buffer.writeUInt32LE(type, offset + 460);
}

function floatBits(value: number): number {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value, 0);
  return bytes.readUInt32LE(0);
}
