export function parseMcpToolResult(result) {
  const raw = result?.content?.find((entry) => entry.type === "text")?.text ?? "";
  try {
    return { raw, response: JSON.parse(raw) };
  } catch {
    throw new Error(`MCP_RESPONSE_NOT_JSON ${raw.slice(0, 500)}`);
  }
}

export function breakpointStop(response) {
  const data = response?.data ?? {};
  const details = data.stopReasonDetails ?? data.stopEvent ?? null;
  const rawReason = data.stopReason ?? details?.reason ?? null;
  if (typeof rawReason === "string") {
    const strict = /^breakpoint-hit(?:\s+breakpoint\s+#(\d+)(?:\s+at\s+(.+?\S))?)?\s*$/.exec(rawReason);
    if (strict) {
      return {
        reason: "breakpoint-hit",
        breakpointId: Number(details?.breakpointNumber ?? details?.bkptno ?? strict[1]),
        details: details ?? { location: strict[2] ?? null, evidenceSource: "strict_stop_reason_parser" },
      };
    }
  }
  throw new Error(`GDB_WAIT_NOT_BREAKPOINT_HIT ${JSON.stringify({ rawReason, details })}`);
}

function targetExecutionState(response) {
  for (const value of [
    response?.after?.targetExecutionState,
    response?.after?.targetState,
    response?.data?.targetExecutionState,
    response?.data?.preservedTargetExecutionState,
  ]) {
    const normalized = String(value ?? "").toLowerCase();
    if (normalized === "running" || normalized === "halted") return normalized;
  }
  return null;
}

export function parseBacktraceFrames(output) {
  if (typeof output !== "string") return null;
  const frames = output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*#(\d+)\s+(.+?\S)\s*$/.exec(line);
    return match ? [{ index: Number(match[1]), text: match[2] }] : [];
  });
  if (frames.length === 0 || frames[0].index !== 0) return null;
  if (frames.some((frame, index) => frame.index !== index)) return null;
  return frames;
}

export function parseBreakpointRecords(output) {
  if (typeof output !== "string") return null;
  if (/^\s*No breakpoints or watchpoints\.\s*$/i.test(output)) return [];
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!/^\s*Num\s+Type\s+Disp\s+Enb\s+Address\s+What\s*$/i.test(lines[0] ?? "")) return null;
  const records = [];
  for (const line of lines.slice(1)) {
    const match = /^\s*(\d+)\s+(.+?\S)\s*$/.exec(line);
    if (match) {
      records.push({ id: Number(match[1]), text: match[2] });
      continue;
    }
    if (/^\s+\S.*$/.test(line) && records.length > 0) {
      records[records.length - 1].text += `\n${line.trim()}`;
      continue;
    }
    return null;
  }
  return records.length > 0 ? records : null;
}

function breakpointRecords(response) {
  const data = response?.data ?? {};
  if (response?.ok !== true || data.success !== true || data.commandDispatched !== true || data.sideEffects !== "read_only") return null;
  const state = targetExecutionState(response);
  if (state !== "halted" || ![data.observedTargetExecutionState, data.preservedTargetExecutionState].includes("halted")) return null;
  const source = Array.isArray(data.breakpoints)
    ? data.breakpoints
    : Array.isArray(data.items) ? data.items : null;
  if (source) {
    const records = source.map((entry) => ({ id: Number(entry?.id ?? entry?.number ?? entry?.breakpointId), entry }));
    return records.every(({ id }) => Number.isSafeInteger(id) && id > 0) ? records : null;
  }
  return parseBreakpointRecords(data.output);
}

function backtraceConfirmed(response) {
  const data = response?.data ?? {};
  const frames = parseBacktraceFrames(data.output);
  return response?.ok === true
    && data.success === true
    && (data.commandDispatched === true || data.dispatchedCommand === "bt full")
    && data.dispatchedCommand === "bt full"
    && Array.isArray(frames)
    && frames.length > 0
    && targetExecutionState(response) === "halted"
    && response?.verification?.status === "observed"
    && response?.verification?.method === "gdb_response";
}

function breakpointDeleteConfirmed(response, breakpointId) {
  const data = response?.data ?? {};
  return response?.ok === true
    && data.success === true
    && data.commandDispatched === true
    && data.breakpointId === breakpointId
    && targetExecutionState(response) === "halted"
    && [data.observedTargetExecutionState, data.preservedTargetExecutionState].includes("halted")
    && response?.verification?.status === "observed"
    && response?.verification?.method === "typed_gdb_breakpoint_delete_and_state_preservation";
}

function resumeConfirmed(response) {
  const data = response?.data ?? {};
  return response?.ok === true
    && data.success === true
    && data.commandDispatched === true
    && targetExecutionState(response) === "running"
    && data.observedTargetExecutionState === "running";
}

function statusOwner(response) {
  for (const candidate of [response?.data, response?.data?.machine, response?.data?.target, response?.data?.runtime, response?.data?.ownership]) {
    if (candidate && Object.prototype.hasOwnProperty.call(candidate, "owner")) return candidate.owner;
  }
  return undefined;
}

export function breakpointInsertionRequiresCleanup({ attempted, succeeded, error }) {
  if (succeeded) return true;
  if (!attempted) return false;
  const call = error?.call;
  const response = call?.response;
  const definitelyUnissued = call?.name === "gdb_command"
    && response?.error?.writeIssued === false
    && response?.data?.commandDispatched !== true;
  return !definitelyUnissued;
}

export function failedCloseConfirmedBreakpointCleanup(response) {
  const effects = response?.observedEffects;
  const cleanup = response?.data?.flashBreakpointCleanup;
  return response?.ok === false
    && response?.after?.owner === null
    && response?.after?.probe?.gdbServer?.running === false
    && Array.isArray(effects)
    && effects.includes("gdb_server_stopped")
    && effects.includes("gdb_owner_released")
    && cleanup?.success === true
    && cleanup?.commandDispatched === true
    && [cleanup.observedTargetExecutionState, cleanup.preservedTargetExecutionState].includes("halted");
}

export async function recoverManagedBreakpointFailure(session, { projectRoot, originalError }) {
  let close = originalError?.call?.name === "gdb_close"
    && failedCloseConfirmedBreakpointCleanup(originalError.call.response)
    ? originalError.call
    : null;
  const reusedOriginalClose = close !== null;
  if (!close) {
    try {
      close = await session.call("gdb_close", { projectRoot });
    } catch (closeError) {
      if (!failedCloseConfirmedBreakpointCleanup(closeError?.call?.response)) throw closeError;
      close = closeError.call;
    }
  }
  session.gdbCloseConfirmed = true;
  const status = await session.call("target_status", { projectRoot });
  if (statusOwner(status.response) !== null) throw new Error("TARGET_OWNER_NOT_NULL_AFTER_BREAKPOINT_FAILURE");
  session.ownerNullConfirmed = true;
  session.preserveLiveTransport = false;
  return { reusedOriginalClose, close, status };
}

export async function completeManagedBreakpointCleanup(
  session,
  { projectRoot, breakpointId, timeoutMs = 30_000, resumeBeforeClose = false },
) {
  const transcript = [];
  try {
    const stop = breakpointStop(session.lastWaitResponse);
    if (stop.breakpointId !== breakpointId) throw new Error(`GDB_BREAKPOINT_ID_MISMATCH expected=${breakpointId} actual=${stop.breakpointId}`);
    const backtrace = await session.call("gdb_backtrace", { projectRoot, full: true });
    transcript.push(backtrace);
    if (!backtraceConfirmed(backtrace.response)) throw new Error("GDB_BACKTRACE_EVIDENCE_UNCONFIRMED");
    const beforeDelete = await session.call("gdb_breakpoint_list", { projectRoot, timeoutMs });
    transcript.push(beforeDelete);
    if (!breakpointRecords(beforeDelete.response)?.some(({ id }) => id === breakpointId)) throw new Error("GDB_BREAKPOINT_LIST_MISSING_EXPECTED_ID");
    const deleted = await session.call("gdb_breakpoint_delete", { projectRoot, breakpointId, timeoutMs });
    transcript.push(deleted);
    if (!breakpointDeleteConfirmed(deleted.response, breakpointId)) throw new Error("GDB_BREAKPOINT_DELETE_EVIDENCE_UNCONFIRMED");
    const afterDelete = await session.call("gdb_breakpoint_list", { projectRoot, timeoutMs });
    transcript.push(afterDelete);
    if (breakpointRecords(afterDelete.response)?.length !== 0) throw new Error("GDB_BREAKPOINT_LIST_NOT_EMPTY");
    if (resumeBeforeClose) {
      const resumed = await session.call("gdb_command", {
        projectRoot,
        command: "continue",
        timeoutMs,
      });
      transcript.push(resumed);
      if (!resumeConfirmed(resumed.response)) throw new Error("GDB_RESUME_BEFORE_CLOSE_UNCONFIRMED");
    }
    transcript.push(await session.call("gdb_close", { projectRoot }));
    session.gdbCloseConfirmed = true;
    const status = await session.call("target_status", { projectRoot });
    transcript.push(status);
    if (statusOwner(status.response) !== null) throw new Error(`TARGET_OWNER_NOT_NULL ${JSON.stringify(statusOwner(status.response))}`);
    session.ownerNullConfirmed = true;
    return { safeToClose: true, transcript };
  } catch (error) {
    session.preserveLiveTransport = true;
    error.transcript = transcript;
    throw error;
  }
}

export class ManagedTransportGate {
  constructor({ client, transport, callTool }) {
    this.client = client;
    this.transport = transport;
    this.callTool = callTool;
    this.gdbOpened = false;
    this.gdbCloseConfirmed = false;
    this.ownerNullConfirmed = false;
    this.preserveLiveTransport = false;
    this.lastWaitResponse = null;
  }

  async call(name, args) {
    if (name === "gdb_open") this.gdbOpened = true;
    try {
      const parsed = parseMcpToolResult(await this.callTool(name, args));
      const call = { name, args, ...parsed };
      if (name === "gdb_wait" && parsed.response.ok === true) this.lastWaitResponse = parsed.response;
      if (parsed.response.ok !== true) {
        const error = new Error(`${name} ${parsed.response?.error?.code ?? "MCP_TOOL_FAILED"}`);
        error.call = call;
        throw error;
      }
      return call;
    } catch (error) {
      if (this.gdbOpened) this.preserveLiveTransport = true;
      throw error;
    }
  }

  async closeIfSafe() {
    if (this.preserveLiveTransport || (this.gdbOpened && !(this.gdbCloseConfirmed && this.ownerNullConfirmed))) {
      throw new Error("LIVE_TRANSPORT_MUST_BE_PRESERVED");
    }
    await this.client.close();
    await this.transport.close();
  }
}
