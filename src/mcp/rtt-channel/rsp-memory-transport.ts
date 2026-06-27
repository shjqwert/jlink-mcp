import net from "net";
import type { DirectRttMemoryIo } from "./direct-rtt-memory-transport";

export interface RspMemoryIoOptions {
  host?: string;
  port: number;
  timeoutMs?: number;
}

export class RspMemoryIo implements DirectRttMemoryIo {
  private pending = Buffer.alloc(0);
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly socket: net.Socket, private readonly timeoutMs: number) {
    socket.on("data", (chunk) => {
      this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    });
    socket.on("error", () => undefined);
  }

  static async connect(options: RspMemoryIoOptions): Promise<RspMemoryIo> {
    const host = options.host ?? "127.0.0.1";
    const timeoutMs = options.timeoutMs ?? 2000;
    const socket = new net.Socket();
    socket.setNoDelay(true);
    const io = new RspMemoryIo(socket, timeoutMs);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`RSP connect timeout to ${host}:${options.port}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("error", onError);
      socket.connect(options.port, host, () => {
        cleanup();
        resolve();
      });
    });

    await io.request("qSupported");
    return io;
  }

  async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array();
    const response = await this.request(`m${address.toString(16)},${length.toString(16)}`);
    if (/^E[0-9a-fA-F]{2}/.test(response)) throw new Error(`RSP memory read failed: ${response}`);
    if (response.length !== length * 2) throw new Error(`RSP memory read returned ${response.length / 2}/${length} bytes`);
    return Uint8Array.from(Buffer.from(response, "hex"));
  }

  async writeByte(address: number, value: number): Promise<void> {
    await this.writeMemoryBytes(address, Uint8Array.from([value & 0xff]));
  }

  async writeUInt32(address: number, value: number): Promise<void> {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value >>> 0, 0);
    await this.writeMemoryBytes(address, bytes);
  }

  async monitor(command: string): Promise<string> {
    return this.enqueue(async () => {
      this.socket.write(encodePacket(`qRcmd,${Buffer.from(command, "utf8").toString("hex")}`));
      const output: string[] = [];
      while (true) {
        const response = await this.readPacket();
        if (response === "OK") return output.join("");
        if (response.startsWith("O")) {
          output.push(Buffer.from(response.slice(1), "hex").toString("utf8"));
          continue;
        }
        if (/^E[0-9a-fA-F]{2}/.test(response)) throw new Error(`RSP monitor command failed: ${response}`);
        throw new Error(`RSP monitor unexpected response: ${response}`);
      }
    });
  }

  dispose(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private async writeMemoryBytes(address: number, bytes: Uint8Array): Promise<void> {
    const response = await this.request(`M${address.toString(16)},${bytes.length.toString(16)}:${Buffer.from(bytes).toString("hex")}`);
    if (response !== "OK") throw new Error(`RSP memory write failed: ${response}`);
  }

  private request(payload: string): Promise<string> {
    return this.enqueue(async () => {
      this.socket.write(encodePacket(payload));
      return this.readPacket();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private readPacket(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("RSP response timeout"));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onData = () => {
        const packet = this.tryReadPacket();
        if (packet === null) return;
        cleanup();
        resolve(packet);
      };

      this.socket.on("data", onData);
      this.socket.once("error", onError);
      onData();
    });
  }

  private tryReadPacket(): string | null {
    while (this.pending.length > 0) {
      const first = this.pending[0];
      if (first === 0x2b || first === 0x2d) {
        this.pending = this.pending.subarray(1);
        continue;
      }

      const start = this.pending.indexOf(0x24);
      if (start < 0) {
        this.pending = Buffer.alloc(0);
        return null;
      }
      if (start > 0) this.pending = this.pending.subarray(start);

      const end = this.pending.indexOf(0x23, 1);
      if (end < 0 || end + 2 >= this.pending.length) return null;

      const payloadBytes = this.pending.subarray(1, end);
      const expected = this.pending.subarray(end + 1, end + 3).toString("ascii").toLowerCase();
      this.pending = this.pending.subarray(end + 3);
      if (expected !== checksum(payloadBytes).toString(16).padStart(2, "0")) {
        this.socket.write("-");
        continue;
      }
      this.socket.write("+");
      return payloadBytes.toString("ascii");
    }
    return null;
  }
}

function encodePacket(payload: string): string {
  const bytes = Buffer.from(payload, "ascii");
  return `$${payload}#${checksum(bytes).toString(16).padStart(2, "0")}`;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return sum;
}
