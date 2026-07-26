import { createOperationEnvelope, failEnvelope, type OperationEnvelope } from "../runtime/operation-envelope";
import type { AgentToolName } from "./tool-contract";

export function relabelEnvelope(envelope: OperationEnvelope, tool: AgentToolName): OperationEnvelope {
  envelope.tool = tool;
  return envelope;
}

export function actionInputFailure(tool: AgentToolName, message: string): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code: "ACTION_INPUT_INVALID",
    stage: "validation",
    message,
    retryable: false,
    writeIssued: false,
    stateUnknown: false,
  });
}
