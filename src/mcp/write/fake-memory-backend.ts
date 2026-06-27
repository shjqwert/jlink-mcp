import { ExperimentRecord } from "../experiment-contract";
import { ScalarType } from "../capture-contract";

export interface FakeSymbol {
  selector: string;
  type: ScalarType;
  address: number;
  value: number;
}

export class FakeMemoryBackend {
  private readonly symbols = new Map<string, FakeSymbol>();
  private readonly samples: NonNullable<ExperimentRecord["samples"]> = [];

  constructor(symbols: FakeSymbol[] = defaultFakeSymbols()) {
    for (const symbol of symbols) this.symbols.set(symbol.selector, { ...symbol });
    this.recordSample();
  }

  readSymbol(selector: string): number {
    const symbol = this.symbols.get(selector);
    if (!symbol) throw new Error(`Unknown symbol: ${selector}`);
    return symbol.value;
  }

  writeSymbol(selector: string, value: number): void {
    const symbol = this.symbols.get(selector);
    if (!symbol) throw new Error(`Unknown symbol: ${selector}`);
    symbol.value = value;
    if (selector === "test.c::g_JlinkMcpTrigger") {
      this.symbol("test.c::g_JlinkMcpObserved").value = value + 1;
      this.symbol("test.c::g_JlinkMcpState").value = value > 0 ? 1 : 0;
    }
    this.recordSample();
  }

  toExperimentRecord(): ExperimentRecord {
    return {
      experimentId: "fake_memory_write_response",
      createdAt: "2026-06-27T00:00:00.000Z",
      source: "synthetic",
      target: { device: "fake-memory" },
      signals: [
        { name: "trigger", selector: "test.c::g_JlinkMcpTrigger", type: "uint32", role: "command" },
        { name: "observed", selector: "test.c::g_JlinkMcpObserved", type: "uint32", role: "feedback" },
        { name: "state", selector: "test.c::g_JlinkMcpState", type: "uint8", role: "state" },
      ],
      events: [],
      samples: this.samples,
    };
  }

  private symbol(selector: string): FakeSymbol {
    const symbol = this.symbols.get(selector);
    if (!symbol) throw new Error(`Unknown symbol: ${selector}`);
    return symbol;
  }

  private recordSample(): void {
    this.samples.push({
      timeMs: this.samples.length * 10,
      values: {
        trigger: this.symbol("test.c::g_JlinkMcpTrigger").value,
        observed: this.symbol("test.c::g_JlinkMcpObserved").value,
        state: this.symbol("test.c::g_JlinkMcpState").value,
      },
    });
  }
}

export function defaultFakeSymbols(): FakeSymbol[] {
  return [
    { selector: "test.c::g_JlinkMcpScratch", type: "uint32", address: 0x20000000, value: 0 },
    { selector: "test.c::g_JlinkMcpTrigger", type: "uint32", address: 0x20000004, value: 0 },
    { selector: "test.c::g_JlinkMcpObserved", type: "uint32", address: 0x20000008, value: 0 },
    { selector: "test.c::g_JlinkMcpFloatRef", type: "float32", address: 0x2000000c, value: 0 },
    { selector: "test.c::g_JlinkMcpState", type: "uint8", address: 0x20000010, value: 0 },
  ];
}
