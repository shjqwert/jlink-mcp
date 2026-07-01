import type { ProbeBackend } from "../../probe/backend";
import { HSS_ERROR, HssError } from "./hss-errors";

export interface HssVariableMemoryIo {
  read(address: number, length: number): Promise<Buffer>;
  write(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<void>;
}

export class ProbeHssVariableMemoryIo implements HssVariableMemoryIo {
  constructor(private readonly probe: ProbeBackend, private readonly owner: string) {}

  async read(address: number, length: number): Promise<Buffer> {
    const result = await this.probe.readMemoryForExclusiveOwner(this.owner, address, length);
    if (!result.success) throw new HssError(HSS_ERROR.OLD_VALUE_READ_FAILED, "probe memory read failed", { address, length, output: result.output, error: result.error });
    const bytes = this.probe.parseMemoryDump(result.rawOutput || result.output)
      .flatMap((line) => line.hex.split(/\s+/).filter(Boolean).map((hex) => Number.parseInt(hex, 16)))
      .filter((value) => Number.isFinite(value));
    if (bytes.length < length) throw new HssError(HSS_ERROR.OLD_VALUE_READ_FAILED, "probe memory read returned too few bytes", { address, length, bytes: bytes.length });
    return Buffer.from(bytes.slice(0, length));
  }

  async write(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<void> {
    const result = await this.probe.writeMemoryForExclusiveOwner(this.owner, address, bytes, accessSize);
    if (!result.success) throw new HssError(HSS_ERROR.UNKNOWN_WRITE_STATE, "probe memory write failed after issue attempt", { address, length: bytes.length, output: result.output, error: result.error, writeIssued: true });
  }
}
