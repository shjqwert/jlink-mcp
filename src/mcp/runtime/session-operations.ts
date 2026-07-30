import { realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { GDBResponse, GDBTargetExecutionState, GDBUnexpectedExit } from "../../gdb/gdb-client";
import { ProbeErrorCode, type ProbeBackend } from "../../probe/backend";
import type { RTTClient } from "../../rtt/rtt-client";
import {
  createOperationEnvelope,
  failEnvelope,
  finishEnvelope,
  type OperationEnvelope,
} from "./operation-envelope";
import { ProbeQueue, ProbeQueueError, type ProbeOwner, type ProbeOwnerKind, type QueueMetadata } from "./probe-queue";
import { MemorySessionError, type MemorySessionManager } from "./memory-session";
import { inspectArtifactFile, TargetStore, TargetStoreError, type StoredTarget } from "./target-store";

export interface SessionGdbClient {
  connect(host?: string, port?: number, elfFile?: string): Promise<GDBResponse>;
  command(command: string, timeout?: number): Promise<GDBResponse>;
  listBreakpoints(timeout?: number): Promise<GDBResponse>;
  deleteBreakpoint(breakpointId: number, timeout?: number): Promise<GDBResponse>;
  clearAllBreakpoints(timeout?: number): Promise<GDBResponse>;
  wait(timeout?: number): Promise<GDBResponse>;
  backtrace(full?: boolean): Promise<GDBResponse>;
  isConnected(): boolean;
  getTargetExecutionState(): GDBTargetExecutionState;
  onUnexpectedExit?(listener: (event: GDBUnexpectedExit) => void): () => void;
  disconnect(): Promise<void>;
}

export interface GdbAttachBoundaryEvidence {
  preServerObservation: {
    observedAt: string;
    state: GDBTargetExecutionState;
    source: string;
    command: unknown;
  };
  serverReadyObservedAt: string;
  server: {
    processId: number;
    ownerToken: string;
    targetGeneration: string;
  };
  serverOutputAtReady: string[];
  serverReadinessEvidence: "waiting_for_gdb_client" | "listener_only" | "unclassified";
  targetExecutionStateAtServerReady: "not_observed";
  profile: {
    configuredDevice: string;
    gdbDevice: string | null;
    effectiveGdbDevice: string;
    interface: string;
    speed: number;
  };
}

export interface SessionTargetRuntime {
  probe: ProbeBackend;
  gdb: SessionGdbClient;
  rtt: RTTClient;
  gdbOwnerToken?: string;
  gdbOwnerExitSubscription?: () => void;
  gdbServerStopping?: boolean;
  gdbServerTargetExecutionState?: GDBTargetExecutionState;
  gdbAttachBoundaryEvidence?: GdbAttachBoundaryEvidence;
  gdbInitialAttachBoundaryAvailable?: boolean;
  gdbClientExitedUnexpectedly?: boolean;
  gdbServerNaturalExitRequired?: boolean;
  gdbManagedBreakpointLifecycle?: {
    attachInitialState: "running";
    lastManagedResumeState: "running";
    stopReason?: string;
    breakpointDeleteDispatched?: boolean;
    emptyBreakpointListObserved?: boolean;
  };
  gdbFlashBreakpointCleanupRequired?: boolean;
  gdbFlashBreakpointCleanupEvidence?: GDBResponse;
  gdbPreServerStateExpectationValid?: boolean;
  gdbClientExitSubscription?: () => void;
  onGdbServerExit?: (listener: () => void) => () => void;
}

export type SessionRuntimeProvider = (target: StoredTarget) => Promise<SessionTargetRuntime>;

export class SessionOperations {
  constructor(
    private readonly targets: TargetStore,
    private readonly queue: ProbeQueue,
    private readonly runtimeFor: SessionRuntimeProvider,
    private readonly memorySessions?: MemorySessionManager,
    private readonly requireUserConfirmation = true,
  ) {}

  gdbServerStart(projectRoot: string): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); }
    catch (error) { return Promise.resolve(this.failure(createOperationEnvelope("gdb_server_start"), error, "target_lookup")); }
    let localMemoryOwner: ProbeOwner | undefined;
    try { localMemoryOwner = this.memorySessions?.localOwnerForTarget(target); }
    catch (error) { return Promise.resolve(this.failure(createOperationEnvelope("gdb_server_start", target), error, "ownership")); }
    return this.queuedWithTarget("gdb_server_start", target, ["start_gdb_server", "acquire_gdb_owner"], localMemoryOwner ? ["memory"] : [], async (envelope, target, runtime, metadata) => {
      const memoryClose = await this.memorySessions?.closeForTarget(target);
      const targetState = await runtime.probe.observeTargetState();
      const preServerObservedAt = new Date().toISOString();
      if (memoryClose) {
        envelope.data = { memorySessionClose: { targetStateBeforeClose: memoryClose.targetStateBeforeClose, targetStateAfterReconnect: targetState.state } };
        if (memoryClose.targetStateBeforeClose === "unknown" || targetState.state === "unknown") {
          throw new SessionError("POST_OPERATION_STATE_UNKNOWN", "memory-session close could not prove the target state before starting the GDB Server", false, false, true);
        }
        if (memoryClose.targetStateBeforeClose !== targetState.state) {
          throw new SessionError("HIDDEN_STATE_CHANGE", `memory-session close changed target state from ${memoryClose.targetStateBeforeClose} to ${targetState.state}`, false, false, false);
        }
      }
      envelope.before = { targetExecutionState: targetState.state, source: targetState.source, command: targetState.result };
      if (targetState.state !== "running") throw disconnectStateError(targetState.state, "starting the GDB Server");
      const result = await runtime.probe.startGDBServer();
      if (!result.success) throw new SessionError("GDB_SERVER_FAILED", result.message, false, false);
      const status = runtime.probe.getGDBServerStatus();
      if (!status.running || !Number.isSafeInteger(status.processId) || Number(status.processId) <= 0) {
        await runtime.probe.stopGDBServer();
        throw new SessionError("GDB_SERVER_IDENTITY_UNAVAILABLE", "GDB Server started without a verifiable process identity; it was stopped before Probe ownership was published", false, false);
      }
      const serverReadyObservedAt = new Date().toISOString();
      let owner: ProbeOwner;
      try {
        owner = this.queue.claimOwner(target.probeSerial, {
          kind: "gdb",
          projectRoot: target.projectRoot,
          targetGeneration: target.generation,
          resourcePid: status.processId,
          details: { gdbPort: target.ports.gdb, rttPort: target.ports.rtt },
        }, metadata.leaseToken);
      } catch (error) {
        await runtime.probe.stopGDBServer();
        throw error;
      }
      runtime.gdbOwnerToken = owner.token;
      runtime.gdbServerTargetExecutionState = "unknown";
      runtime.gdbClientExitedUnexpectedly = false;
      runtime.gdbServerNaturalExitRequired = false;
      runtime.gdbManagedBreakpointLifecycle = undefined;
      runtime.gdbFlashBreakpointCleanupRequired = false;
      runtime.gdbFlashBreakpointCleanupEvidence = undefined;
      runtime.gdbPreServerStateExpectationValid = true;
      const serverOutputAtReady = runtime.probe.getGDBServerOutput(200);
      runtime.gdbAttachBoundaryEvidence = {
        preServerObservation: {
          observedAt: preServerObservedAt,
          state: targetState.state,
          source: targetState.source,
          command: targetState.result,
        },
        serverReadyObservedAt,
        server: {
          processId: Number(status.processId),
          ownerToken: owner.token,
          targetGeneration: target.generation,
        },
        serverOutputAtReady,
        serverReadinessEvidence: classifyGdbServerReadiness(serverOutputAtReady),
        targetExecutionStateAtServerReady: "not_observed",
        profile: {
          configuredDevice: target.device,
          gdbDevice: target.gdbDevice ?? null,
          effectiveGdbDevice: target.gdbDevice ?? target.device,
          interface: target.interface,
          speed: target.speed,
        },
      };
      runtime.gdbInitialAttachBoundaryAvailable = true;
      runtime.gdbOwnerExitSubscription?.();
      runtime.gdbOwnerExitSubscription = runtime.onGdbServerExit?.(() => {
        if (runtime.gdbOwnerToken !== owner.token) return;
        if (runtime.gdbServerStopping) return;
        runtime.gdbServerTargetExecutionState = "unknown";
        runtime.gdbAttachBoundaryEvidence = undefined;
        runtime.gdbInitialAttachBoundaryAvailable = false;
        runtime.gdbPreServerStateExpectationValid = false;
        runtime.gdbServerNaturalExitRequired = false;
        runtime.gdbManagedBreakpointLifecycle = undefined;
        void (async () => {
          try {
            await this.targets.setMemoryMutationTrust(target.projectRoot, "unverified", "gdb_server_unexpected_exit", {
              targetGeneration: target.generation,
              probeSerial: target.probeSerial,
              artifactGeneration: target.artifact?.generation,
            });
          } catch {
            // Keep the live owner record as a fail-closed gate when Artifact
            // invalidation cannot be persisted.
            return;
          }
          try { this.queue.releaseOwner(target.probeSerial, owner.token); } catch { /* already released or replaced */ }
          if (runtime.gdbOwnerToken === owner.token) runtime.gdbOwnerToken = undefined;
        })();
      });
      if (!runtime.probe.isGDBServerRunning()) {
        runtime.gdbOwnerExitSubscription?.();
        runtime.gdbOwnerExitSubscription = undefined;
        if (runtime.gdbOwnerToken === owner.token) this.queue.releaseOwner(target.probeSerial, owner.token);
        runtime.gdbOwnerToken = undefined;
        runtime.gdbAttachBoundaryEvidence = undefined;
        runtime.gdbInitialAttachBoundaryAvailable = false;
        runtime.gdbPreServerStateExpectationValid = false;
        throw new SessionError("GDB_SERVER_EXITED", "GDB Server exited before ownership could be established", true, false);
      }
      envelope.observedEffects.push("gdb_server_started", "gdb_owner_acquired");
      envelope.data = {
        ...(envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {}),
        message: result.message,
        owner,
        status,
        attachBoundaryEvidence: runtime.gdbAttachBoundaryEvidence,
      };
      envelope.verification = { status: "observed", method: "process_manager" };
    }, localMemoryOwner);
  }

  async gdbServerStop(projectRoot: string): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return this.failure(createOperationEnvelope("gdb_server_stop"), error, "target_lookup"); }
    const runtime = await this.trackedRuntimeFor(target);
    const owner = this.requireGdbOwner("gdb_server_stop", target);
    if (owner instanceof OperationEnvelopeFailure) return owner.envelope;
    if (!runtime.gdbOwnerToken || runtime.gdbOwnerToken !== owner.token) {
      return failEnvelope(createOperationEnvelope("gdb_server_stop", target), {
        code: "GDB_OWNER_PROCESS_MISMATCH", stage: "ownership", message: "GDB Server is owned by another live MCP process", retryable: false, writeIssued: false, stateUnknown: false,
      });
    }
    return this.queuedWithTarget("gdb_server_stop", target, ["clear_gdb_server_breakpoints", "stop_gdb_server", "release_gdb_owner"], ["gdb"], async (envelope) => {
      const clientWasConnected = runtime.gdb.isConnected();
      const executionState = clientWasConnected ? runtime.gdb.getTargetExecutionState() : runtime.gdbServerTargetExecutionState ?? "unknown";
      const recoveringAfterClientExit = !clientWasConnected
        && executionState === "unknown"
        && runtime.gdbClientExitedUnexpectedly === true;
      if (clientWasConnected || runtime.gdbClientExitedUnexpectedly === true) {
        runtime.gdbServerNaturalExitRequired = true;
      }
      const waitForSingleRunExit = runtime.gdbServerNaturalExitRequired === true;
      const attachBoundary = runtime.gdbAttachBoundaryEvidence?.server.ownerToken === owner.token
        && runtime.gdbAttachBoundaryEvidence.server.targetGeneration === target.generation
        ? runtime.gdbAttachBoundaryEvidence
        : undefined;
      const targetExecutionStateExpectedBeforeClose = executionState !== "unknown"
        ? executionState
        : recoveringAfterClientExit
          ? "unknown"
          : runtime.gdbPreServerStateExpectationValid
            ? attachBoundary?.preServerObservation.state ?? "unknown"
            : "unknown";
      const managedBreakpointLifecycle = runtime.gdbManagedBreakpointLifecycle;
      const managedBreakpointDetachResumeExpected = waitForSingleRunExit
        && executionState === "halted"
        && attachBoundary?.preServerObservation.state === "running"
        && managedBreakpointLifecycle?.attachInitialState === "running"
        && managedBreakpointLifecycle.lastManagedResumeState === "running"
        && managedBreakpointLifecycle.stopReason !== undefined
        && managedBreakpointLifecycle.breakpointDeleteDispatched === true
        && managedBreakpointLifecycle.emptyBreakpointListObserved === true;
      const targetExecutionStateExpectedAfterClose = managedBreakpointDetachResumeExpected
        ? "running"
        : targetExecutionStateExpectedBeforeClose;
      const closeStateExpectationSource = managedBreakpointDetachResumeExpected
        ? "managed_breakpoint_detach_resume"
        : executionState !== "unknown"
          ? "current_gdb_state"
          : recoveringAfterClientExit
            ? "unavailable_after_unexpected_client_exit"
            : attachBoundary && runtime.gdbPreServerStateExpectationValid
              ? "pre_gdb_server_observation"
              : "unavailable";
      const closeIntent = waitForSingleRunExit
        ? "disconnect_client_and_allow_single_run_exit"
        : "stop_server_without_client_connection";
      const flashBreakpointCleanupRequired = runtime.gdbFlashBreakpointCleanupRequired === true;
      envelope.before = {
        gdbClientConnected: clientWasConnected,
        targetExecutionState: executionState,
        targetExecutionStateExpectedBeforeClose,
        targetExecutionStateExpectedAfterClose,
        expectationSource: closeStateExpectationSource,
        closeIntent,
        gdbServerRunning: runtime.probe.isGDBServerRunning(),
      };
      if (targetExecutionStateExpectedBeforeClose === "unknown" && !recoveringAfterClientExit) {
        throw disconnectStateError(executionState, "stopping the GDB Server");
      }
      if (
        flashBreakpointCleanupRequired
        && !runtime.gdbFlashBreakpointCleanupEvidence
        && (!clientWasConnected || executionState !== "halted")
      ) {
        throw new SessionError(
          executionState === "unknown" ? "TARGET_STATE_UNKNOWN" : "HALT_REQUIRED",
          "pending J-Link FlashBP cleanup requires the managed GDB client to remain connected with the target halted",
          false,
          false,
          executionState === "unknown",
        );
      }
      runtime.gdbServerStopping = true;
      try {
        let flashBreakpointCleanup = runtime.gdbFlashBreakpointCleanupEvidence;
        if (flashBreakpointCleanupRequired && !flashBreakpointCleanup) {
          try {
            flashBreakpointCleanup = await runtime.gdb.clearAllBreakpoints();
          } catch (error) {
            runtime.gdbServerTargetExecutionState = "unknown";
            throw new SessionError(
              "GDB_FLASH_BREAKPOINT_CLEANUP_FAILED",
              error instanceof Error ? error.message : String(error),
              false,
              true,
              true,
            );
          }
          const executionStateAfterCleanup = runtime.gdb.getTargetExecutionState();
          runtime.gdbServerTargetExecutionState = executionStateAfterCleanup;
          envelope.data = {
            flashBreakpointCleanup,
            targetExecutionStateAfterFlashBreakpointCleanup: executionStateAfterCleanup,
          };
          if (executionStateAfterCleanup !== "halted") {
            throw new SessionError(
              "HIDDEN_STATE_CHANGE",
              `clearing all J-Link GDB Server breakpoints changed target state from halted to ${executionStateAfterCleanup}`,
              false,
              flashBreakpointCleanup.commandDispatched === true,
              executionStateAfterCleanup === "unknown",
            );
          }
          if (!flashBreakpointCleanup.success) {
            throw new SessionError(
              "GDB_FLASH_BREAKPOINT_CLEANUP_FAILED",
              flashBreakpointCleanup.error ?? "J-Link GDB Server did not confirm that all pending breakpoints were removed",
              false,
              flashBreakpointCleanup.commandDispatched === true,
              false,
            );
          }
          if (
            flashBreakpointCleanup.commandDispatched !== true
            || (
              flashBreakpointCleanup.observedTargetExecutionState !== "halted"
              && flashBreakpointCleanup.preservedTargetExecutionState !== "halted"
            )
          ) {
            throw new SessionError(
              "GDB_FLASH_BREAKPOINT_CLEANUP_UNCONFIRMED",
              "J-Link GDB Server breakpoint cleanup returned without halted-state preservation evidence",
              false,
              flashBreakpointCleanup.commandDispatched === true,
              false,
            );
          }
          runtime.gdbFlashBreakpointCleanupEvidence = flashBreakpointCleanup;
          envelope.observedEffects.push("gdb_server_breakpoints_cleared");
        }
        await runtime.gdb.disconnect();
        runtime.rtt.disconnect();
        let serverExitObservation: Awaited<ReturnType<ProbeBackend["waitForGDBServerExit"]>> | undefined;
        if (waitForSingleRunExit) {
          serverExitObservation = await runtime.probe.waitForGDBServerExit(3_000);
          envelope.data = { serverExitObservation };
          if (!serverExitObservation.exited) {
            throw new SessionError(
              "GDB_SERVER_GRACEFUL_EXIT_TIMEOUT",
              "GDB Server did not exit naturally after the GDB connection closed; forced termination was not attempted because breakpoint cleanup is unconfirmed",
              false,
              true,
              true,
            );
          }
          if (!serverExitObservation.clean) {
            throw new SessionError(
              "GDB_SERVER_GRACEFUL_EXIT_UNCONFIRMED",
              "GDB Server exited without a clean single-run exit; breakpoint cleanup is unconfirmed and ownership remains fail-closed",
              false,
              true,
              true,
            );
          }
        }
        const result = await runtime.probe.stopGDBServer();
        if (!result.success) throw new SessionError("GDB_SERVER_STOP_FAILED", result.message, false, true, true);
        runtime.gdbAttachBoundaryEvidence = undefined;
        runtime.gdbInitialAttachBoundaryAvailable = false;
        runtime.gdbClientExitedUnexpectedly = false;
        runtime.gdbServerNaturalExitRequired = false;
        runtime.gdbManagedBreakpointLifecycle = undefined;
        runtime.gdbFlashBreakpointCleanupRequired = false;
        runtime.gdbFlashBreakpointCleanupEvidence = undefined;
        runtime.gdbPreServerStateExpectationValid = false;
        runtime.gdbOwnerExitSubscription?.();
        runtime.gdbOwnerExitSubscription = undefined;
        if (runtime.gdbOwnerToken === owner.token) {
          this.queue.releaseOwner(target.probeSerial, owner.token);
          runtime.gdbOwnerToken = undefined;
        }
        envelope.observedEffects.push(clientWasConnected ? "gdb_client_disconnected" : "gdb_client_already_disconnected", "rtt_disconnected", "gdb_server_stopped", "gdb_owner_released");
        let finalState: GDBTargetExecutionState;
        try { finalState = (await runtime.probe.observeTargetState()).state; }
        catch { finalState = "unknown"; }
        runtime.gdbServerTargetExecutionState = finalState;
        envelope.after = { gdbClientConnected: runtime.gdb.isConnected(), targetExecutionState: finalState, gdbServerRunning: runtime.probe.isGDBServerRunning() };
        envelope.data = {
          message: result.message,
          status: runtime.probe.getGDBServerStatus(),
          targetExecutionStateBeforeDisconnect: executionState,
          targetExecutionStateExpectedBeforeClose,
          targetExecutionStateExpectedAfterClose,
          targetExecutionStateAfterClose: finalState,
          closeStateExpectationSource,
          closeIntent,
          managedBreakpointLifecycle: managedBreakpointLifecycle ?? null,
          flashBreakpointCleanup: flashBreakpointCleanup ?? null,
          serverExitMode: waitForSingleRunExit
            ? "single_run_after_gdb_disconnect"
            : "explicit_stop_without_gdb_connection",
          serverExitObservation: serverExitObservation ?? null,
        };
        if (finalState === "unknown") throw new SessionError("POST_OPERATION_STATE_UNKNOWN", "GDB Server stopped, but target state could not be observed afterward", false, true, true);
        if (!recoveringAfterClientExit && finalState !== targetExecutionStateExpectedAfterClose) {
          throw new SessionError(
            "HIDDEN_STATE_CHANGE",
            managedBreakpointDetachResumeExpected
              ? `clean single-run GDB detach did not restore the proven managed running state; observed ${finalState}`
              : executionState === "unknown"
                ? `target state after GDB Server close was ${finalState}, not the ${targetExecutionStateExpectedAfterClose} state observed before Server start`
                : `GDB Server close changed target state from ${executionState} to ${finalState}`,
            false,
            true,
            false,
          );
        }
        if (managedBreakpointDetachResumeExpected) {
          envelope.observedEffects.push("target_state_restored_by_single_run_detach:halted->running");
        }
        envelope.verification = {
          status: "verified",
          method: managedBreakpointDetachResumeExpected
            ? "managed_breakpoint_explicit_server_clear_single_run_detach_and_post_server_probe_observation"
            : flashBreakpointCleanup
              ? "gdb_explicit_server_breakpoint_clear_and_post_server_probe_observation"
            : waitForSingleRunExit
              ? "gdb_single_run_exit_and_post_server_probe_observation"
              : "gdb_state_before_close_and_post_server_probe_observation",
        };
        if (recoveringAfterClientExit) {
          envelope.warnings.push("The GDB client exited before close, so pre-close target state was unknown; only the final post-server Probe observation is verified.");
        }
      } finally {
        runtime.gdbServerStopping = false;
      }
    }, owner);
  }

  gdbConnect(projectRoot: string, symbolFile?: string, restoreRunningStateAfterAttach = false): Promise<OperationEnvelope> {
    const requestedEffects = ["connect_gdb_client"];
    if (restoreRunningStateAfterAttach) requestedEffects.push("restore_running_state_after_attach");
    return this.withGdbOwner("gdb_connect", projectRoot, requestedEffects, async (envelope, target, runtime) => {
      const executionStateBeforeConnect = runtime.gdbServerTargetExecutionState ?? "unknown";
      const serverStatus = runtime.probe.getGDBServerStatus();
      const attachBoundary = runtime.gdbInitialAttachBoundaryAvailable
        && runtime.gdbAttachBoundaryEvidence
        && runtime.gdbAttachBoundaryEvidence.server.ownerToken === runtime.gdbOwnerToken
        && runtime.gdbAttachBoundaryEvidence.server.targetGeneration === target.generation
        && runtime.gdbAttachBoundaryEvidence.server.processId === serverStatus.processId
        && serverStatus.running
        ? runtime.gdbAttachBoundaryEvidence
        : undefined;
      const targetExecutionStateExpectedAfterAttach = executionStateBeforeConnect === "running"
        ? "running"
        : attachBoundary?.preServerObservation.state ?? "unknown";
      envelope.before = {
        ...(envelope.before as Record<string, unknown>),
        targetExecutionState: executionStateBeforeConnect,
        targetExecutionStateExpectedAfterAttach,
        expectationSource: attachBoundary ? "pre_gdb_server_observation" : "current_gdb_state",
        gdbClientConnected: runtime.gdb.isConnected(),
      };
      if (targetExecutionStateExpectedAfterAttach !== "running") {
        throw disconnectStateError(executionStateBeforeConnect, "connecting the GDB client");
      }
      const explicitSymbols = symbolFile ? canonicalSymbolFile(symbolFile) : undefined;
      if (explicitSymbols && target.artifact?.path !== explicitSymbols) throw new SessionError("CONFIGURED_ARTIFACT_REQUIRED", "symbolFile must match the content-hashed Artifact configured by target_configure", false, false);
      if (explicitSymbols && target.artifact) {
        let liveArtifact: ReturnType<typeof inspectArtifactFile> | undefined;
        try { liveArtifact = inspectArtifactFile(target.projectRoot, explicitSymbols); } catch { /* handled below as stale */ }
        if (!liveArtifact || liveArtifact.sha256 !== target.artifact.sha256 || liveArtifact.size !== target.artifact.size) {
          const updated = await this.targets.setArtifactMatch(target.projectRoot, "unverified", "artifact_file_changed_before_gdb_load", {
            targetGeneration: target.generation,
            probeSerial: target.probeSerial,
            artifactGeneration: target.artifact.generation,
          });
          envelope.artifact = this.artifactSummary(updated);
          throw new SessionError("ARTIFACT_STALE", "configured Artifact content changed; run target_configure again before loading symbols", false, false);
        }
      }
      runtime.gdbInitialAttachBoundaryAvailable = false;
      runtime.gdbClientExitedUnexpectedly = false;
      const result = await runtime.gdb.connect("localhost", target.ports.gdb, explicitSymbols);
      const firstGdbFrameObservedAt = new Date().toISOString();
      const serverOutputAtClientResponse = runtime.probe.getGDBServerOutput(200);
      envelope.data = {
        ...result,
        symbolFile: explicitSymbols ?? null,
        targetExecutionStateBeforeConnect: executionStateBeforeConnect,
        targetExecutionStateExpectedAfterAttach,
        attachBoundaryEvidence: attachBoundary ?? null,
        serverOutputAtClientResponse,
      };
      const executionStateAfterConnect = runtime.gdb.getTargetExecutionState();
      runtime.gdbServerTargetExecutionState = executionStateAfterConnect;
      if (!result.success) throw gdbError(result, "gdb_connect", true);
      runtime.gdbPreServerStateExpectationValid = false;
      if (explicitSymbols && target.artifact) {
        let liveArtifact: ReturnType<typeof inspectArtifactFile> | undefined;
        try { liveArtifact = inspectArtifactFile(target.projectRoot, explicitSymbols); } catch { /* handled below as stale */ }
        if (!liveArtifact || liveArtifact.sha256 !== target.artifact.sha256 || liveArtifact.size !== target.artifact.size) {
          const updated = await this.targets.setArtifactMatch(target.projectRoot, "unverified", "artifact_file_changed_during_gdb_load", {
            targetGeneration: target.generation,
            probeSerial: target.probeSerial,
            artifactGeneration: target.artifact.generation,
          });
          envelope.artifact = this.artifactSummary(updated);
          const executionState = executionStateAfterConnect;
          runtime.gdbServerTargetExecutionState = executionState;
          envelope.observedEffects.push("gdb_client_connected", "artifact_became_stale_during_symbol_load");
          if (executionState !== targetExecutionStateExpectedAfterAttach) {
            envelope.observedEffects.push(
              executionStateBeforeConnect === "unknown"
                ? `unexpected_target_state_observation:expected_${targetExecutionStateExpectedAfterAttach}->${executionState}`
                : `unexpected_target_state_change:${executionStateBeforeConnect}->${executionState}`,
            );
          }
          if (executionState === "running") {
            await runtime.gdb.disconnect();
            runtime.gdbServerTargetExecutionState = "running";
            envelope.observedEffects.push("gdb_client_disconnected");
          }
          envelope.data = {
            ...result,
            symbolFile: explicitSymbols,
            targetExecutionStateBeforeConnect: executionStateBeforeConnect,
            targetExecutionStateExpectedAfterAttach,
            targetExecutionStateAfterConnect: executionState,
            targetExecutionState: executionState,
            gdbClientConnected: runtime.gdb.isConnected(),
            cleanup: executionState === "running" ? "client_disconnected" : "client_retained_to_avoid_hidden_resume",
          };
          const message = executionState === "running"
            ? "Artifact content changed while GDB loaded symbols; the running-state client was disconnected"
            : "Artifact content changed while GDB loaded symbols; the client remains connected to avoid an implicit resume. Explicitly resume, then disconnect and run target_configure again";
          throw new SessionError("ARTIFACT_STALE", message, false, true, executionState === "unknown");
        }
      }
      if (executionStateAfterConnect !== targetExecutionStateExpectedAfterAttach) {
        if (executionStateAfterConnect === "halted" && gdbAttachReportedFault(result)) {
          envelope.observedEffects.push("gdb_client_connected", "gdb_attach_halted_target", "target_fault_observed");
          envelope.data = {
            ...result,
            symbolFile: explicitSymbols ?? null,
            targetExecutionStateBeforeConnect: executionStateBeforeConnect,
            targetExecutionStateExpectedAfterAttach,
            targetExecutionStateAfterConnect: executionStateAfterConnect,
            gdbClientConnected: runtime.gdb.isConnected(),
            cleanup: "client_retained_and_fault_not_resumed",
            attachBoundaryEvidence: attachBoundary ?? null,
            serverOutputAtClientResponse,
            firstGdbFrame: {
              observedAt: firstGdbFrameObservedAt,
              classification: "fault_handler",
              causalAttribution: "indeterminate",
              observationWindow: "after_pre_server_observation_through_first_gdb_frame",
            },
          };
          throw new SessionError(
            "TARGET_FAULT_OBSERVED_AT_FIRST_GDB_FRAME",
            "The first GDB frame shows a target stopped in a fault handler. Available evidence cannot determine whether it faulted before or during the managed GDB Server attach; the client remains connected and the target was not resumed",
            false,
            true,
            false,
          );
        }
        const attachStopClassification = gdbAttachStopClassification(result);
        if (restoreRunningStateAfterAttach
            && executionStateAfterConnect === "halted"
            && targetExecutionStateExpectedAfterAttach === "running"
            && attachStopClassification) {
          envelope.observedEffects.push("gdb_client_connected", "gdb_attach_halted_target");
          const restore = await runtime.gdb.command("-exec-continue --all");
          const executionStateAfterRestore = runtime.gdb.getTargetExecutionState();
          runtime.gdbServerTargetExecutionState = executionStateAfterRestore;
          envelope.data = {
            ...result,
            symbolFile: explicitSymbols ?? null,
            targetExecutionStateBeforeConnect: executionStateBeforeConnect,
            targetExecutionStateExpectedAfterAttach,
            targetExecutionStateAfterConnect: executionStateAfterConnect,
            targetExecutionStateAfterRestore: executionStateAfterRestore,
            attachStopClassification,
            restoreRunningStateAfterAttachAuthorized: true,
            stateRestore: restore,
            gdbClientConnected: runtime.gdb.isConnected(),
          };
          if (!restore.success || executionStateAfterRestore !== "running") {
            throw new SessionError(
              "GDB_ATTACH_STATE_RESTORE_FAILED",
              "GDB attach halted the running target and the requested running state could not be restored",
              false,
              true,
              executionStateAfterRestore === "unknown",
            );
          }
          envelope.observedEffects.push("target_state_restored:halted->running");
          if (attachStopClassification === "reasonless_attach_like_stop") {
            envelope.warnings.push(
              "The reasonless J-Link stop could not distinguish an attach halt from an application BKPT, watchpoint, or non-standard fault; running state was restored only because the caller explicitly authorized it.",
            );
          }
          envelope.verification = { status: "verified", method: "gdb_attach_response_and_explicit_continue" };
          return;
        }
        envelope.observedEffects.push(
          "gdb_client_connected",
          executionStateBeforeConnect === "unknown"
            ? `unexpected_target_state_observation:expected_${targetExecutionStateExpectedAfterAttach}->${executionStateAfterConnect}`
            : `unexpected_target_state_change:${executionStateBeforeConnect}->${executionStateAfterConnect}`,
        );
        envelope.data = {
          ...result,
          symbolFile: explicitSymbols ?? null,
          targetExecutionStateBeforeConnect: executionStateBeforeConnect,
          targetExecutionStateExpectedAfterAttach,
          targetExecutionStateAfterConnect: executionStateAfterConnect,
          restoreRunningStateAfterAttachAuthorized: restoreRunningStateAfterAttach,
          gdbClientConnected: runtime.gdb.isConnected(),
          cleanup: "client_retained_to_avoid_hidden_resume",
        };
        throw new SessionError(
          "HIDDEN_STATE_CHANGE",
          executionStateBeforeConnect === "unknown"
            ? `the first GDB observation was ${executionStateAfterConnect}, not the ${targetExecutionStateExpectedAfterAttach} state expected from pre-Server evidence; the client remains connected to avoid an implicit state change`
            : `connecting the GDB client changed target state from ${executionStateBeforeConnect} to ${executionStateAfterConnect}; the client remains connected to avoid another implicit state change`,
          false,
          true,
          executionStateAfterConnect === "unknown",
        );
      }
      envelope.observedEffects.push("gdb_client_connected");
      runtime.gdbServerTargetExecutionState = runtime.gdb.getTargetExecutionState();
      envelope.data = {
        ...result,
        symbolFile: explicitSymbols ?? null,
        targetExecutionStateBeforeConnect: executionStateBeforeConnect,
        targetExecutionStateExpectedAfterAttach,
        targetExecutionStateAfterConnect: executionStateAfterConnect,
      };
      envelope.verification = { status: "observed", method: "gdb_response" };
    });
  }

  gdbCommand(projectRoot: string, command: string, timeoutMs = 15_000, userConfirmed = false): Promise<OperationEnvelope> {
    if (this.requireUserConfirmation && !userConfirmed) return userConfirmationRequired();
    if (!command || /[\0\r\n]/.test(command)) return Promise.resolve(validationFailure("gdb_command", "command must be one exact single-line GDB command"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.resolve(validationFailure("gdb_command", "timeoutMs must be 1..120000"));
    return this.withGdbOwner("gdb_command", projectRoot, ["raw_gdb_command", "unknown_side_effects"], async (envelope, target, runtime) => {
      if (!runtime.gdb.isConnected()) throw new SessionError("GDB_NOT_CONNECTED", "gdb_connect must be called first", false, false);
      const executionStateBefore = runtime.gdb.getTargetExecutionState();
      const result = await runtime.gdb.command(command, timeoutMs);
      const breakpointInsertionDispatched = result.commandDispatched === true
        && result.dispatchedCommand?.startsWith("-break-insert ") === true;
      if (breakpointInsertionDispatched) {
        runtime.gdbFlashBreakpointCleanupRequired = true;
        runtime.gdbFlashBreakpointCleanupEvidence = undefined;
      }
      runtime.gdbManagedBreakpointLifecycle = undefined;
      runtime.gdbServerTargetExecutionState = result.observedTargetExecutionState ?? "unknown";
      runtime.gdbPreServerStateExpectationValid = false;
      const sideEffects = breakpointInsertionDispatched
        ? "breakpoint_configuration_and_possible_firmware_overlay"
        : "unknown";
      envelope.data = { command, ...result, sideEffects };
      try {
        if (breakpointInsertionDispatched) {
          await this.targets.setArtifactMatch(target.projectRoot, "unverified", "gdb_breakpoint_insert", {
            targetGeneration: target.generation,
            probeSerial: target.probeSerial,
            artifactGeneration: target.artifact?.generation,
          });
        }
        const updated = await this.targets.setMemoryMutationTrust(target.projectRoot, "unverified", "gdb_command", {
          targetGeneration: target.generation,
          probeSerial: target.probeSerial,
          artifactGeneration: target.artifact?.generation,
        });
        envelope.artifact = this.artifactSummary(updated);
      } catch (error) {
        const code = error instanceof TargetStoreError ? error.code : "ARTIFACT_STATE_PERSIST_FAILED";
        throw new SessionError(code, error instanceof Error ? error.message : String(error), false, true, true);
      }
      if (!result.success) throw gdbError(result, "gdb_command", true, runtime.gdbServerTargetExecutionState === "unknown");
      const attachBoundary = runtime.gdbAttachBoundaryEvidence;
      if (
        breakpointInsertionDispatched
        && executionStateBefore === "running"
        && runtime.gdbServerTargetExecutionState === "running"
        && attachBoundary?.preServerObservation.state === "running"
        && attachBoundary.server.ownerToken === runtime.gdbOwnerToken
        && attachBoundary.server.targetGeneration === target.generation
      ) {
        runtime.gdbManagedBreakpointLifecycle = {
          attachInitialState: "running",
          lastManagedResumeState: "running",
        };
      } else if (breakpointInsertionDispatched) {
        runtime.gdbManagedBreakpointLifecycle = undefined;
      }
      envelope.observedEffects.push("raw_gdb_command_issued", "side_effects_unknown");
      envelope.data = { command, ...result, sideEffects };
      envelope.verification = { status: "executed_unverified" };
      envelope.warnings.push("Raw GDB command semantics are not interpreted; side effects are unknown.");
      if (breakpointInsertionDispatched) {
        envelope.warnings.push("Managed breakpoint insertion may use J-Link FlashBP; firmware identity remains unverified until a later explicit Verify-only operation succeeds after GDB cleanup.");
      }
      envelope.artifact = this.artifactSummary(this.targets.require(target.projectRoot));
    });
  }

  gdbBreakpointList(projectRoot: string, timeoutMs = 15_000): Promise<OperationEnvelope> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.resolve(validationFailure("gdb_breakpoint_list", "timeoutMs must be 1..120000"));
    return this.withGdbOwner("gdb_breakpoint_list", projectRoot, ["gdb_breakpoints_read"], async (envelope, _target, runtime) => {
      if (!runtime.gdb.isConnected()) throw new SessionError("GDB_NOT_CONNECTED", "gdb_connect must be called first", false, false);
      const executionStateBefore = runtime.gdb.getTargetExecutionState();
      if (
        executionStateBefore === "unknown"
        || runtime.gdbServerTargetExecutionState === "unknown"
        || runtime.gdbServerTargetExecutionState !== executionStateBefore
      ) {
        throw new SessionError("TARGET_STATE_UNKNOWN", "target state is not consistently known before breakpoint listing; no command was issued", false, false, true);
      }
      envelope.before = { ...(envelope.before as Record<string, unknown>), targetExecutionState: executionStateBefore };
      const result = await runtime.gdb.listBreakpoints(timeoutMs);
      const executionStateAfter = runtime.gdb.getTargetExecutionState();
      runtime.gdbServerTargetExecutionState = executionStateAfter;
      envelope.data = { ...result, targetExecutionState: executionStateAfter, sideEffects: "read_only" };
      envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: executionStateAfter };
      if (executionStateAfter !== executionStateBefore) {
        throw new SessionError(
          "HIDDEN_STATE_CHANGE",
          `breakpoint listing changed target state from ${executionStateBefore} to ${executionStateAfter}`,
          false,
          false,
          executionStateAfter === "unknown",
        );
      }
      if (!result.success) throw gdbError(result, "gdb_breakpoint_list", false, false);
      if (
        result.observedTargetExecutionState !== executionStateAfter
        && result.preservedTargetExecutionState !== executionStateAfter
      ) {
        runtime.gdbServerTargetExecutionState = "unknown";
        envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: "unknown" };
        throw new SessionError("TARGET_STATE_UNKNOWN", "breakpoint listing returned no valid execution-state observation or typed preservation evidence", false, false, true);
      }
      if (runtime.gdbManagedBreakpointLifecycle?.breakpointDeleteDispatched === true) {
        runtime.gdbManagedBreakpointLifecycle.emptyBreakpointListObserved =
          executionStateAfter === "halted"
          && /^\s*No breakpoints or watchpoints\.\s*$/i.test(result.output);
      }
      envelope.verification = { status: "observed", method: "typed_read_only_gdb_command" };
    });
  }

  gdbBreakpointDelete(projectRoot: string, breakpointId: number, timeoutMs = 15_000): Promise<OperationEnvelope> {
    if (!Number.isSafeInteger(breakpointId) || breakpointId < 1) return Promise.resolve(validationFailure("gdb_breakpoint_delete", "breakpointId must be a positive integer"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.resolve(validationFailure("gdb_breakpoint_delete", "timeoutMs must be 1..120000"));
    return this.withGdbOwner("gdb_breakpoint_delete", projectRoot, ["gdb_breakpoint_delete", "memory_mutation_trust_invalidated"], async (envelope, target, runtime) => {
      if (!runtime.gdb.isConnected()) throw new SessionError("GDB_NOT_CONNECTED", "gdb_connect must be called first", false, false);
      const executionStateBefore = runtime.gdb.getTargetExecutionState();
      const serverExecutionStateBefore = runtime.gdbServerTargetExecutionState;
      if (
        executionStateBefore === "unknown"
        || serverExecutionStateBefore === "unknown"
        || executionStateBefore !== serverExecutionStateBefore
      ) {
        throw new SessionError(
          "TARGET_STATE_UNKNOWN",
          "target state is not consistently known before breakpoint deletion; no command was issued",
          false,
          false,
          true,
        );
      }
      if (executionStateBefore !== "halted") {
        throw new SessionError(
          "HALT_REQUIRED",
          "breakpoint deletion requires a halted target; no command was issued",
          false,
          false,
          false,
        );
      }
      envelope.before = { ...(envelope.before as Record<string, unknown>), targetExecutionState: executionStateBefore };
      const result = await runtime.gdb.deleteBreakpoint(breakpointId, timeoutMs);
      const commandDispatched = result.commandDispatched === true;
      const executionStateAfter = runtime.gdb.getTargetExecutionState();
      runtime.gdbServerTargetExecutionState = executionStateAfter;
      runtime.gdbPreServerStateExpectationValid = false;
      envelope.data = {
        breakpointId,
        ...result,
        targetExecutionState: executionStateAfter,
        sideEffects: "breakpoint_configuration_and_possible_memory_mutation",
      };
      envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: executionStateAfter };
      if (commandDispatched) {
        try {
          const updated = await this.targets.setMemoryMutationTrust(target.projectRoot, "unverified", "gdb_breakpoint_delete", {
            targetGeneration: target.generation,
            probeSerial: target.probeSerial,
            artifactGeneration: target.artifact?.generation,
          });
          envelope.artifact = this.artifactSummary(updated);
        } catch (error) {
          const code = error instanceof TargetStoreError ? error.code : "ARTIFACT_STATE_PERSIST_FAILED";
          throw new SessionError(code, error instanceof Error ? error.message : String(error), false, true, executionStateAfter === "unknown");
        }
      }
      if (executionStateAfter !== executionStateBefore) {
        throw new SessionError(
          "HIDDEN_STATE_CHANGE",
          `breakpoint deletion changed target state from ${executionStateBefore} to ${executionStateAfter}`,
          false,
          commandDispatched,
          executionStateAfter === "unknown",
        );
      }
      if (!result.success) throw gdbError(result, "gdb_breakpoint_delete", commandDispatched, false);
      if (
        result.observedTargetExecutionState !== executionStateAfter
        && result.preservedTargetExecutionState !== executionStateAfter
      ) {
        runtime.gdbServerTargetExecutionState = "unknown";
        envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: "unknown" };
        throw new SessionError("TARGET_STATE_UNKNOWN", "breakpoint deletion returned no valid execution-state observation or typed preservation evidence", false, true, true);
      }
      if (runtime.gdbManagedBreakpointLifecycle?.stopReason && commandDispatched) {
        runtime.gdbManagedBreakpointLifecycle.breakpointDeleteDispatched = true;
        runtime.gdbManagedBreakpointLifecycle.emptyBreakpointListObserved = false;
      }
      envelope.verification = { status: "observed", method: "typed_gdb_breakpoint_delete_and_state_preservation" };
    });
  }

  gdbWait(projectRoot: string, timeoutMs = 30_000): Promise<OperationEnvelope> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.resolve(validationFailure("gdb_wait", "timeoutMs must be 1..120000"));
    return this.withGdbOwner("gdb_wait", projectRoot, [], async (envelope, _target, runtime) => {
      if (!runtime.gdb.isConnected()) throw new SessionError("GDB_NOT_CONNECTED", "gdb_connect must be called first", false, false);
      const executionStateBefore = runtime.gdb.getTargetExecutionState();
      envelope.before = { ...(envelope.before as Record<string, unknown>), targetExecutionState: executionStateBefore };
      if (executionStateBefore === "unknown") {
        runtime.gdbManagedBreakpointLifecycle = undefined;
        throw new SessionError("TARGET_STATE_UNKNOWN", "target state is unknown before gdb_wait; no wait was started", false, false, true);
      }
      if (executionStateBefore === "halted" && !runtime.gdbManagedBreakpointLifecycle) {
        runtime.gdbServerTargetExecutionState = "halted";
        envelope.data = { success: true, output: "Target is already halted", stopReason: "already-halted", noOp: true, observedTargetExecutionState: "halted" };
        envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: "halted" };
        envelope.verification = { status: "observed", method: "gdb_cached_state" };
        return;
      }
      let result: Awaited<ReturnType<SessionGdbClient["wait"]>>;
      try {
        result = await runtime.gdb.wait(timeoutMs);
      } catch (error) {
        runtime.gdbManagedBreakpointLifecycle = undefined;
        throw error;
      }
      runtime.gdbServerTargetExecutionState = runtime.gdb.getTargetExecutionState();
      envelope.data = result;
      envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: runtime.gdbServerTargetExecutionState };
      if (!result.success) {
        runtime.gdbManagedBreakpointLifecycle = undefined;
        throw gdbError(result, "gdb_wait", false, runtime.gdbServerTargetExecutionState === "unknown");
      }
      if (runtime.gdbServerTargetExecutionState === "unknown") {
        runtime.gdbManagedBreakpointLifecycle = undefined;
        throw new SessionError("TARGET_STATE_UNKNOWN", "target state became unknown while waiting", false, false, true);
      }
      if (runtime.gdbServerTargetExecutionState === "halted") {
        if (
          runtime.gdbManagedBreakpointLifecycle
          && /^breakpoint-hit(?:\s|$)/.test(result.stopReason ?? "")
        ) {
          runtime.gdbManagedBreakpointLifecycle.stopReason = result.stopReason;
        } else {
          runtime.gdbManagedBreakpointLifecycle = undefined;
        }
      }
      envelope.verification = {
        status: "observed",
        method: runtime.gdbServerTargetExecutionState === "running" ? "gdb_running_timeout" : "gdb_stop_event",
      };
    });
  }

  gdbBacktrace(projectRoot: string, full = false): Promise<OperationEnvelope> {
    return this.withGdbOwner("gdb_backtrace", projectRoot, [], async (envelope, _target, runtime) => {
      if (!runtime.gdb.isConnected()) throw new SessionError("GDB_NOT_CONNECTED", "gdb_connect must be called first", false, false);
      const executionStateBefore = runtime.gdb.getTargetExecutionState();
      envelope.before = { ...(envelope.before as Record<string, unknown>), targetExecutionState: executionStateBefore };
      if (executionStateBefore === "running") {
        throw new SessionError("HALT_REQUIRED", "backtrace requires a halted target; call halt explicitly if appropriate", false, false);
      }
      if (executionStateBefore === "unknown") {
        throw new SessionError("TARGET_STATE_UNKNOWN", "target state is unknown before backtrace; no backtrace command was issued", false, false, true);
      }
      const result = await runtime.gdb.backtrace(full);
      const executionStateAfter = runtime.gdb.getTargetExecutionState();
      runtime.gdbServerTargetExecutionState = executionStateAfter;
      envelope.data = result;
      envelope.after = { ...(envelope.after as Record<string, unknown>), targetExecutionState: executionStateAfter };
      if (executionStateAfter !== executionStateBefore) {
        throw new SessionError(
          "HIDDEN_STATE_CHANGE",
          `backtrace changed target state from ${executionStateBefore} to ${executionStateAfter}`,
          false,
          false,
          executionStateAfter === "unknown",
        );
      }
      if (!result.success) {
        const text = `${result.error ?? ""} ${result.output}`;
        if (/running|must be halted|cannot execute.*while/i.test(text)) throw new SessionError("HALT_REQUIRED", "backtrace is unavailable while the target runs; call halt explicitly if appropriate", false, false);
        throw gdbError(result, "gdb_backtrace");
      }
      envelope.data = result;
      envelope.verification = { status: "observed", method: "gdb_response" };
    });
  }

  async managedGdbBacktrace(projectRoot: string, full = false): Promise<OperationEnvelope | undefined> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); }
    catch { return undefined; }
    const owner = this.queue.getOwner(target.probeSerial);
    if (!owner || owner.kind !== "gdb") return undefined;
    return this.gdbBacktrace(projectRoot, full);
  }

  rttConnect(projectRoot: string): Promise<OperationEnvelope> {
    return this.queued("rtt_connect", projectRoot, ["connect_existing_rtt_endpoint"], ["gdb"], async (envelope, _target, runtime) => {
      try { await runtime.rtt.connect(); } catch (error) { throw new SessionError("RTT_NOT_AVAILABLE", `cannot connect to existing RTT endpoint: ${error instanceof Error ? error.message : String(error)}`, true, false); }
      envelope.observedEffects.push("rtt_connected");
      envelope.data = runtime.rtt.getStats();
      envelope.verification = { status: "observed", method: "tcp_connection" };
    });
  }

  rttDisconnect(projectRoot: string): Promise<OperationEnvelope> {
    return this.localRtt("rtt_disconnect", projectRoot, (envelope, runtime) => {
      const wasConnected = runtime.rtt.isConnected();
      runtime.rtt.disconnect();
      envelope.requestedEffects = ["disconnect_rtt_client"];
      envelope.observedEffects = [wasConnected ? "rtt_disconnected" : "no_op"];
      envelope.data = { wasConnected, ...runtime.rtt.getStats() };
    });
  }

  rttRead(projectRoot: string, count = 50): Promise<OperationEnvelope> {
    return this.localRtt("rtt_read", projectRoot, (envelope, runtime) => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new SessionError("INVALID_ARGUMENT", "count must be 1..1000", false, false);
      envelope.data = { lines: runtime.rtt.getLines(count), stats: runtime.rtt.getStats() };
    });
  }

  rttSearch(projectRoot: string, input: { level?: string; module?: string; pattern?: string; count?: number }): Promise<OperationEnvelope> {
    return this.localRtt("rtt_search", projectRoot, (envelope, runtime) => {
      const count = input.count ?? 100;
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new SessionError("INVALID_ARGUMENT", "count must be 1..1000", false, false);
      envelope.data = { matches: runtime.rtt.search({ ...input, count }), stats: runtime.rtt.getStats() };
    });
  }

  rttClear(projectRoot: string): Promise<OperationEnvelope> {
    return this.localRtt("rtt_clear", projectRoot, (envelope, runtime) => {
      runtime.rtt.clearBuffer();
      envelope.requestedEffects = ["clear_local_rtt_buffer"];
      envelope.observedEffects = ["local_rtt_buffer_cleared"];
      envelope.data = runtime.rtt.getStats();
    });
  }

  private withGdbOwner(
    tool: string,
    projectRoot: string,
    effects: string[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: SessionTargetRuntime, metadata: QueueMetadata) => Promise<void>,
  ): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "target_lookup")); }
    const owner = this.requireGdbOwner(tool, target);
    if (owner instanceof OperationEnvelopeFailure) return Promise.resolve(owner.envelope);
    return this.queuedWithTarget(tool, target, effects, ["gdb"], operation, owner);
  }

  private requireGdbOwner(tool: string, target: StoredTarget): ProbeOwner | OperationEnvelopeFailure {
    const owner = this.queue.getOwner(target.probeSerial);
    if (!owner) return new OperationEnvelopeFailure(failEnvelope(createOperationEnvelope(tool, target), {
      code: "GDB_SERVER_REQUIRED", stage: "prerequisite", message: "gdb_server_start must be called explicitly first", retryable: false, writeIssued: false, stateUnknown: false,
    }));
    if (owner.kind !== "gdb") {
      const memoryOwner = owner.kind === "memory";
      return new OperationEnvelopeFailure(this.failure(createOperationEnvelope(tool, target), new ProbeQueueError(
        memoryOwner ? "MEMORY_SESSION_ACTIVE" : "CAPTURE_ACTIVE",
        memoryOwner ? "persistent native memory session owns this Probe" : "HSS capture owns this Probe",
        owner,
      ), "ownership"));
    }
    if (owner.projectRoot !== target.projectRoot || owner.targetGeneration !== target.generation) return new OperationEnvelopeFailure(failEnvelope(createOperationEnvelope(tool, target), {
      code: "GDB_SESSION_ACTIVE", stage: "ownership", message: "GDB Server owner belongs to a different Target generation", retryable: false, writeIssued: false, stateUnknown: false,
    }));
    return owner;
  }

  private queued(
    tool: string,
    projectRoot: string,
    effects: string[],
    allowedOwners: ProbeOwnerKind[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: SessionTargetRuntime, metadata: QueueMetadata) => Promise<void>,
  ): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "target_lookup")); }
    return this.queuedWithTarget(tool, target, effects, allowedOwners, operation);
  }

  private async queuedWithTarget(
    tool: string,
    target: StoredTarget,
    effects: string[],
    allowedOwners: ProbeOwnerKind[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: SessionTargetRuntime, metadata: QueueMetadata) => Promise<void>,
    requiredOwner?: ProbeOwner,
  ): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope(tool, target);
    envelope.requestedEffects = effects;
    envelope.before = { owner: this.queue.getOwner(target.probeSerial) ?? null, targetGeneration: target.generation };
    let activeMetadata: QueueMetadata | undefined;
    let activeRuntime: SessionTargetRuntime | undefined;
    try {
      const execution = await this.queue.runExclusive(target.probeSerial, async (metadata) => {
        activeMetadata = metadata;
        envelope.queueSequence = metadata.queueSequence;
        envelope.timestamps.queuedAt = metadata.queuedAt;
        envelope.timestamps.startedAt = metadata.startedAt;
        const current = this.targets.requireCurrent(target);
        activeRuntime = await this.trackedRuntimeFor(current);
        envelope.before = sessionObservation(activeRuntime, this.queue.getOwner(target.probeSerial));
        await operation(envelope, current, activeRuntime, metadata);
        envelope.after = sessionObservation(activeRuntime, this.queue.getOwner(target.probeSerial));
      }, {
        allowedOwnerKinds: allowedOwners,
        ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
        requiredOwner,
      });
      envelope.timestamps.endedAt = execution.endedAt;
      return finishEnvelope(envelope, true);
    } catch (error) {
      if (activeRuntime) envelope.after = sessionObservation(activeRuntime, this.queue.getOwner(target.probeSerial));
      if (activeMetadata) {
        envelope.queueSequence = activeMetadata.queueSequence;
        envelope.timestamps.queuedAt = activeMetadata.queuedAt;
        envelope.timestamps.startedAt = activeMetadata.startedAt;
      }
      let finalError = error;
      if (sessionInvalidatesConnectionEvidence(error, envelope)) {
        try {
          const updated = await this.targets.setMemoryMutationTrust(target.projectRoot, "unverified", "probe_connection_identity_lost", {
            targetGeneration: target.generation,
            probeSerial: target.probeSerial,
            artifactGeneration: target.artifact?.generation,
          });
          envelope.artifact = this.artifactSummary(updated);
        } catch (invalidationError) {
          const code = invalidationError instanceof TargetStoreError ? invalidationError.code : "ARTIFACT_STATE_PERSIST_FAILED";
          finalError = new SessionError(code, invalidationError instanceof Error ? invalidationError.message : String(invalidationError), false, false, true);
        }
      }
      return this.failure(envelope, finalError, activeMetadata ? "execution" : "queue");
    }
  }

  private localRtt(tool: string, projectRoot: string, operation: (envelope: OperationEnvelope, runtime: SessionTargetRuntime) => void): Promise<OperationEnvelope> {
    return this.localTarget(tool, projectRoot, async (envelope, target) => operation(envelope, await this.trackedRuntimeFor(target)));
  }

  private async trackedRuntimeFor(target: StoredTarget): Promise<SessionTargetRuntime> {
    const runtime = await this.runtimeFor(target);
    if (!runtime.gdbClientExitSubscription && runtime.gdb.onUnexpectedExit) {
      runtime.gdbClientExitSubscription = runtime.gdb.onUnexpectedExit(() => {
        runtime.gdbServerTargetExecutionState = "unknown";
        runtime.gdbInitialAttachBoundaryAvailable = false;
        runtime.gdbClientExitedUnexpectedly = true;
        runtime.gdbPreServerStateExpectationValid = false;
        runtime.gdbManagedBreakpointLifecycle = undefined;
      });
    }
    return runtime;
  }

  private async localTarget(tool: string, projectRoot: string, operation: (envelope: OperationEnvelope, target: StoredTarget) => void | Promise<void>): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return this.failure(createOperationEnvelope(tool), error, "target_lookup"); }
    const envelope = createOperationEnvelope(tool, target);
    try {
      envelope.before = { owner: this.queue.getOwner(target.probeSerial) ?? null, targetGeneration: target.generation };
      await operation(envelope, target);
      envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, targetGeneration: target.generation };
      envelope.verification = { status: "observed", method: "local_state" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "local_operation");
    }
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof SessionError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: error.writeIssued, stateUnknown: error.stateUnknown });
    if (error instanceof TargetStoreError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: false, writeIssued: false, stateUnknown: false });
    if (error instanceof ProbeQueueError) {
      attachQueueOwner(envelope, error);
      const code = queueFailureCode(error);
      return failEnvelope(envelope, { code, stage, message: error.message, retryable: code.endsWith("_ACTIVE"), writeIssued: false, stateUnknown: false });
    }
    if (error instanceof MemorySessionError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: false, stateUnknown: error.stateUnknown });
    return failEnvelope(envelope, { code: "INTERNAL_ERROR", stage, message: error instanceof Error ? error.message : String(error), retryable: false, writeIssued: false, stateUnknown: false });
  }

  private artifactSummary(target: StoredTarget): OperationEnvelope["artifact"] {
    return target.artifact ? {
      generation: target.artifact.generation,
      path: target.artifact.path,
      match: target.liveArtifactMatch.status,
      firmwareIdentity: target.liveArtifactMatch.status,
      mutationTrust: target.liveMemoryMutationTrust.status,
      evidenceSource: target.liveArtifactMatch.source,
      evidenceTimestamp: target.liveArtifactMatch.timestamp,
      mutationTrustSource: target.liveMemoryMutationTrust.source,
      mutationTrustTimestamp: target.liveMemoryMutationTrust.timestamp,
    } : null;
  }
}

function gdbAttachReportedFault(result: { output?: string; rawOutput?: string }): boolean {
  return /\b(?:HardFault|MemManage|BusFault|UsageFault|NMI)_Handler\b/i.test(`${result.output ?? ""}\n${result.rawOutput ?? ""}`);
}

function classifyGdbServerReadiness(
  output: readonly string[],
): GdbAttachBoundaryEvidence["serverReadinessEvidence"] {
  const text = output.join("\n");
  if (/Waiting for (?:GDB )?connection|Waiting for connection from GDB/i.test(text)) {
    return "waiting_for_gdb_client";
  }
  if (/Listening on TCP\/IP port/i.test(text)) return "listener_only";
  return "unclassified";
}

function gdbAttachStopClassification(
  result: { rawOutput?: string },
): "sigtrap_stop" | "reasonless_attach_like_stop" | undefined {
  for (const line of (result.rawOutput ?? "").split(/\r?\n/)) {
    if (!line.startsWith("*stopped,")) continue;
    if (
      /(?:^|,)reason="signal-received"(?:,|$)/.test(line)
      && /(?:^|,)signal-name="SIGTRAP"(?:,|$)/.test(line)
    ) return "sigtrap_stop";
    if (
      !/(?:^|,)reason="/.test(line)
      && !/(?:^|,)signal-name="/.test(line)
      && /(?:^|,)frame=\{[^}]*\baddr="0x[0-9a-f]+"[^}]*\bfunc="[^"]+"[^}]*\}/i.test(line)
      && /,thread-id="\d+",stopped-threads="all"(?:,|$)/.test(line)
    ) return "reasonless_attach_like_stop";
  }
  return undefined;
}

function userConfirmationRequired(): Promise<OperationEnvelope> {
  return Promise.resolve(failEnvelope(createOperationEnvelope("gdb_command"), {
    code: "USER_CONFIRMATION_REQUIRED",
    stage: "confirmation",
    message: "gdb_command can have destructive or unknown side effects. Obtain explicit user approval for this exact command, then retry with userConfirmed=true.",
    retryable: true,
    writeIssued: false,
    stateUnknown: false,
  }));
}

function queueFailureCode(error: ProbeQueueError): string {
  return error.code === "OWNER_CHANGED" && error.owner?.kind === "memory" ? "MEMORY_SESSION_ACTIVE" : error.code;
}

function attachQueueOwner(envelope: OperationEnvelope, error: ProbeQueueError): void {
  if (!error.owner) return;
  if (envelope.probe) envelope.probe.owner = error.owner;
  const before = envelope.before && typeof envelope.before === "object" && !Array.isArray(envelope.before)
    ? envelope.before as Record<string, unknown>
    : {};
  envelope.before = { ...before, owner: error.owner };
}

class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly writeIssued: boolean, readonly stateUnknown = false) {
    super(message);
    this.name = "SessionError";
  }
}

class OperationEnvelopeFailure {
  constructor(readonly envelope: OperationEnvelope) {}
}

function gdbError(result: GDBResponse, stage: string, issued = false, stateUnknown = issued): SessionError {
  return new SessionError(result.code ?? "GDB_COMMAND_FAILED", result.error || result.output || `${stage} failed`, false, issued, stateUnknown);
}

function disconnectStateError(state: GDBTargetExecutionState, action: string): SessionError {
  return state === "halted"
    ? new SessionError("RESUME_REQUIRED", `target is halted; call resume or a GDB continue command explicitly before ${action}`, false, false)
    : new SessionError("TARGET_STATE_UNKNOWN", `target execution state is unknown; establish an explicit running state before ${action}`, false, false, true);
}

function canonicalSymbolFile(filePath: string): string {
  if (!isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) throw new SessionError("INVALID_SYMBOL_FILE", "symbolFile must be an existing absolute file", false, false);
  let canonical: string;
  try { canonical = normalize(realpathSync.native(filePath)); } catch { throw new SessionError("SYMBOL_FILE_NOT_FOUND", "symbolFile does not exist", false, false); }
  if (!statSync(canonical).isFile()) throw new SessionError("INVALID_SYMBOL_FILE", "symbolFile must identify a file", false, false);
  return canonical;
}

function validationFailure(tool: string, message: string): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), { code: "INVALID_ARGUMENT", stage: "validation", message, retryable: false, writeIssued: false, stateUnknown: false });
}

function sessionObservation(runtime: SessionTargetRuntime, owner: ProbeOwner | undefined): Record<string, unknown> {
  const gdbTargetExecutionState = runtime.gdb.getTargetExecutionState();
  return {
    owner: owner ?? null,
    probe: runtime.probe.getStatus(),
    gdbConnected: runtime.gdb.isConnected(),
    gdbTargetExecutionState,
    targetExecutionState: runtime.gdb.isConnected() ? gdbTargetExecutionState : runtime.gdbServerTargetExecutionState ?? "unknown",
    rtt: runtime.rtt.getStats(),
  };
}

const SESSION_CONNECTION_EVIDENCE_ERROR_CODES = new Set<string>([
  ProbeErrorCode.PROBE_NOT_FOUND,
  ProbeErrorCode.TARGET_UNREACHABLE,
  ProbeErrorCode.ATTACH_FAILED,
  ProbeErrorCode.ATTACH_UNDER_RESET_FAILED,
  ProbeErrorCode.STATE_DESYNC,
  ProbeErrorCode.DEVICE_NOT_CONFIGURED,
  ProbeErrorCode.TIMEOUT,
  ProbeErrorCode.PROBE_IDENTITY_MISMATCH,
]);

function sessionInvalidatesConnectionEvidence(error: unknown, envelope: OperationEnvelope): boolean {
  if (error instanceof SessionError && SESSION_CONNECTION_EVIDENCE_ERROR_CODES.has(error.code)) return true;
  return containsConnectionEvidenceError(envelope.before) || containsConnectionEvidenceError(envelope.after) || containsConnectionEvidenceError(envelope.data);
}

function containsConnectionEvidenceError(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if ("errorCode" in value) {
    const errorCode = (value as { errorCode?: unknown }).errorCode;
    if (typeof errorCode === "string" && SESSION_CONNECTION_EVIDENCE_ERROR_CODES.has(errorCode)) return true;
  }
  return Object.values(value).some((item) => containsConnectionEvidenceError(item, seen));
}
