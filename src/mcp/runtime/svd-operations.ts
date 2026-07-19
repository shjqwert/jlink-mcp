import type { HssScalarType } from "../hss/hss-contract";
import type { HssTargetEndian } from "../hss/hss-typed-value";
import {
  assertFieldWriteSafe,
  assertRegisterReadable,
  assertWholeRegisterWriteSafe,
  loadSvdCatalog,
  SvdCatalogError,
  type SvdCatalog,
  type SvdResolvedSelector,
} from "../svd/svd-catalog";
import {
  createOperationEnvelope,
  failEnvelope,
  type OperationEnvelope,
} from "./operation-envelope";
import { DirectMcuService, type NonObserveComparator, type ScalarComparator } from "./direct-operations";
import { assertSvdBindingCurrent, TargetStore, TargetStoreError, type StoredTarget } from "./target-store";
import type { VariableComparatorInput } from "./artifact-operations";

export interface RegisterWriteInput {
  projectRoot: string;
  selector: string;
  value: number;
  captureOld?: boolean;
  verify?: boolean;
  restore?: boolean;
  comparator?: VariableComparatorInput;
}

export class SvdRegisterService {
  private readonly cache = new Map<string, SvdCatalog>();

  constructor(private readonly targets: TargetStore, private readonly direct: DirectMcuService) {}

  readRegister(projectRoot: string, selector: string): Promise<OperationEnvelope> {
    return this.readRegisters(projectRoot, [selector], "read_register");
  }

  async readRegisters(projectRoot: string, selectors: string[], tool = "read_registers"): Promise<OperationEnvelope> {
    let target: StoredTarget;
    let catalog: SvdCatalog;
    let resolved: SvdResolvedSelector[];
    try {
      if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 32) throw new SvdCatalogError("SVD_READ_BATCH_INVALID", "read_registers accepts 1 to 32 selectors");
      target = this.targets.require(projectRoot);
      catalog = this.catalog(target);
      resolved = selectors.map((selector) => catalog.resolve(selector));
      for (const item of resolved) assertRegisterReadable(item);
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "svd_resolution"));
    }
    const envelope = await this.direct.structuredReadBatch({
      projectRoot: target.projectRoot,
      operationTool: tool,
      expectedTargetGeneration: target.generation,
      expectedSvdSha256: catalog.sha256,
      requests: resolved.map((item) => ({
        address: item.register.address,
        width: item.register.width,
        byteCount: item.register.width / 8,
        semanticData: { selector: item.selector, svdSha256: catalog.sha256 },
      })),
    });
    if (envelope.data && typeof envelope.data === "object") {
      const results = (envelope.data as { results?: Array<Record<string, unknown>> }).results ?? [];
      results.forEach((result, index) => decorateRead(result, resolved[index], catalog.endian));
      envelope.data = { results, svd: { path: catalog.path, sha256: catalog.sha256, endian: catalog.endian } };
    }
    return envelope;
  }

  async writeRegister(input: RegisterWriteInput): Promise<OperationEnvelope> {
    let target: StoredTarget;
    let catalog: SvdCatalog;
    let resolved: SvdResolvedSelector;
    let dataHex: string;
    let rmw: { mask: number; value: number; endian: HssTargetEndian } | undefined;
    let comparator: ScalarComparator;
    try {
      target = this.targets.require(input.projectRoot);
      catalog = this.catalog(target);
      resolved = catalog.resolve(input.selector);
      if (resolved.field) {
        const fieldWrite = assertFieldWriteSafe(resolved, input.value);
        rmw = { mask: fieldWrite.mask, value: fieldWrite.shiftedValue, endian: catalog.endian };
        dataHex = Buffer.alloc(resolved.register.width / 8).toString("hex");
        comparator = registerComparator(input.comparator ?? { mode: "exact" }, resolved, input.value, catalog.endian, true);
      } else {
        assertWholeRegisterWriteSafe(resolved, input.value);
        if (input.captureOld || input.verify || input.restore) assertRegisterReadable(resolved);
        dataHex = encodeUnsigned(input.value, resolved.register.width, catalog.endian).toString("hex");
        comparator = registerComparator(input.comparator ?? { mode: "exact" }, resolved, input.value, catalog.endian, false);
      }
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope("write_register"), error, "svd_resolution"));
    }
    const envelope = await this.direct.structuredWrite({
      projectRoot: target.projectRoot,
      operationTool: "write_register",
      expectedTargetGeneration: target.generation,
      expectedSvdSha256: catalog.sha256,
      address: resolved.register.address,
      width: resolved.register.width,
      byteCount: resolved.register.width / 8,
      dataHex,
      knownRegion: "peripheral",
      captureOld: input.captureOld ?? false,
      verify: input.verify ?? false,
      restore: input.restore ?? false,
      comparator,
      rmw,
      semanticData: {
        selector: resolved.selector,
        register: resolved.register.selector,
        field: resolved.field?.name,
        requestedValue: input.value,
        svdSha256: catalog.sha256,
        implicitReadModifyWrite: Boolean(resolved.field),
      },
    });
    decorateWrite(envelope, resolved, catalog.endian);
    if (envelope.error?.writeIssued || envelope.observedEffects.includes("structured_memory_write_issued")) {
      envelope.warnings.push("Peripheral register bytes were issued; wider MCU/system-level effects remain unknown unless separately observed.");
    }
    return envelope;
  }

  private catalog(target: StoredTarget): SvdCatalog {
    const binding = assertSvdBindingCurrent(target);
    const key = `${binding.path}\0${binding.sha256}`;
    let catalog = this.cache.get(key);
    if (!catalog) {
      catalog = loadSvdCatalog(binding.path, binding.sha256);
      this.cache.set(key, catalog);
    }
    return catalog;
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof SvdCatalogError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof TargetStoreError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    return failEnvelope(envelope, operationError("SVD_OPERATION_FAILED", stage, error instanceof Error ? error.message : String(error)));
  }
}

function decorateRead(result: Record<string, unknown>, resolved: SvdResolvedSelector | undefined, endian: HssTargetEndian): void {
  if (!resolved || typeof result.dataHex !== "string") return;
  const rawValue = decodeUnsigned(Buffer.from(result.dataHex, "hex"), endian);
  result.rawValue = rawValue;
  result.register = resolved.register;
  if (resolved.field) result.fieldValue = extractField(rawValue, resolved.field.lsb, resolved.field.width);
}

function decorateWrite(envelope: OperationEnvelope, resolved: SvdResolvedSelector, endian: HssTargetEndian): void {
  if (!envelope.data || typeof envelope.data !== "object") return;
  const data = envelope.data as Record<string, unknown>;
  for (const [hexKey, valueKey] of [["oldHex", "oldRegisterValue"], ["requestedHex", "requestedRegisterValue"], ["readbackHex", "readbackRegisterValue"]] as const) {
    const hex = data[hexKey];
    if (typeof hex !== "string") continue;
    const value = decodeUnsigned(Buffer.from(hex, "hex"), endian);
    data[valueKey] = value;
    if (resolved.field) data[valueKey.replace("Register", "Field")] = extractField(value, resolved.field.lsb, resolved.field.width);
  }
}

function registerComparator(input: VariableComparatorInput, resolved: SvdResolvedSelector, requestedValue: number, endian: HssTargetEndian, fieldWrite: boolean): ScalarComparator {
  const type = unsignedType(resolved.register.width);
  if (input.mode === "tolerance") {
    if (fieldWrite) throw new SvdCatalogError("SVD_FIELD_COMPARATOR_UNSUPPORTED", "tolerance verification is not safe for a field read-modify-write; use exact, masked, or observe");
    return { mode: "tolerance", expected: requestedValue, absTolerance: input.absTolerance, relTolerance: input.relTolerance, type, endian };
  }
  if (input.mode === "exact") return fieldWrite ? { mode: "exact" } : { mode: "exact", type, endian };
  if (input.mode === "masked") return fieldWrite ? { mode: "masked", maskHex: input.maskHex } : { mode: "masked", maskHex: input.maskHex, type, endian };
  return {
    mode: "observe",
    durationMs: input.durationMs,
    maxPolls: input.maxPolls,
    intervalMs: input.intervalMs,
    comparator: registerComparator(input.comparator, resolved, requestedValue, endian, fieldWrite) as NonObserveComparator,
  };
}

function unsignedType(width: 8 | 16 | 32): HssScalarType {
  return width === 8 ? "uint8" : width === 16 ? "uint16" : "uint32";
}

function encodeUnsigned(value: number, width: 8 | 16 | 32, endian: HssTargetEndian): Buffer {
  const bytes = Buffer.alloc(width / 8);
  if (endian === "little") bytes.writeUIntLE(value, 0, bytes.length);
  else bytes.writeUIntBE(value, 0, bytes.length);
  return bytes;
}

function decodeUnsigned(bytes: Buffer, endian: HssTargetEndian): number {
  return endian === "little" ? bytes.readUIntLE(0, bytes.length) : bytes.readUIntBE(0, bytes.length);
}

function extractField(value: number, lsb: number, width: number): number {
  return width === 32 ? value >>> 0 : Math.floor(value / 2 ** lsb) % 2 ** width;
}

function operationError(code: string, stage: string, message: string) {
  return { code, stage, message, retryable: false, writeIssued: false, stateUnknown: false };
}
