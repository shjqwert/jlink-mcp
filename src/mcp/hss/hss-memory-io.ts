import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { HSS_ERROR, HssError } from "./hss-errors";

export interface HssVariableMemoryIo {
  read(address: number, length: number): Promise<Buffer>;
  write(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<void | HssMemoryWriteReceipt>;
}

export interface HssMemoryWriteReceipt {
  operationBeforeQpcCounter?: string;
  operationAfterQpcCounter?: string;
}

export class HelperHssVariableMemoryIo implements HssVariableMemoryIo {
  constructor(
    private readonly requestFile: string,
    private readonly responseFile: string,
    private readonly captureId: string,
    private readonly timeoutMs = 5000,
  ) {}

  async read(address: number, length: number): Promise<Buffer> {
    const response = await this.request({ op: "read", address: hexAddress(address), length });
    const bytes = decodeHex(String(response.bytesHex ?? ""));
    if (bytes.length < length) throw new HssError(HSS_ERROR.OLD_VALUE_READ_FAILED, "helper read returned too few bytes", { address, length, bytes: bytes.length });
    return bytes.subarray(0, length);
  }

  async write(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<HssMemoryWriteReceipt> {
    const response = await this.request({ op: "write", address: hexAddress(address), length: bytes.length, accessSize, bytesHex: bytes.toString("hex") });
    return {
      operationBeforeQpcCounter: decimalU64(response.operationBeforeQpcCounter),
      operationAfterQpcCounter: decimalU64(response.operationAfterQpcCounter),
    };
  }

  async resume(): Promise<Record<string, unknown>> {
    return this.request({ op: "resume" });
  }

  private async request(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `hwr_${randomUUID()}`;
    const temporaryRequestFile = `${this.requestFile}.${requestId}.tmp`;
    await rm(this.responseFile, { force: true });
    await rm(this.requestFile, { force: true });
    await writeFile(temporaryRequestFile, JSON.stringify({ requestId, captureId: this.captureId, ...input }), "utf8");
    await rename(temporaryRequestFile, this.requestFile);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(this.responseFile)) {
        const response = JSON.parse(await readFile(this.responseFile, "utf8")) as Record<string, unknown>;
        if (response.requestId !== requestId) {
          await sleep(5);
          continue;
        }
        await rm(this.responseFile, { force: true }).catch(() => undefined);
        if (response.status !== "ok") {
          throw new HssError(input.op === "read" ? HSS_ERROR.OLD_VALUE_READ_FAILED : HSS_ERROR.UNKNOWN_WRITE_STATE, String(response.reason ?? "helper memory request failed"), {
            helper: response,
            writeIssued: response.writeIssued === true,
          });
        }
        return response;
      }
      await sleep(5);
    }
    throw new HssError(input.op === "read" ? HSS_ERROR.OLD_VALUE_READ_FAILED : HSS_ERROR.UNKNOWN_WRITE_STATE, "helper memory request timed out", {
      requestId,
      requestFile: this.requestFile,
      responseFile: this.responseFile,
      writeIssued: false,
    });
  }
}

function decodeHex(hex: string): Buffer {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new HssError(HSS_ERROR.READBACK_FAILED, "helper returned invalid hex bytes", { hex });
  return Buffer.from(hex, "hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexAddress(address: number): string {
  return `0x${address.toString(16)}`;
}

function decimalU64(value: unknown): string | undefined {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? value : undefined;
}
