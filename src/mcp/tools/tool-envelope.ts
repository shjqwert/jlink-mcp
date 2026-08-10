import { createOperationEnvelope, failEnvelope, type OperationEnvelope } from "../runtime/operation-envelope";

export function relabelEnvelope(envelope: OperationEnvelope, tool: string): OperationEnvelope {
  envelope.tool = tool;
  return envelope;
}

export function actionInputFailure(tool: string, message: string): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code: "ACTION_INPUT_INVALID",
    stage: "validation",
    message,
    retryable: false,
    writeIssued: false,
    stateUnknown: false,
  });
}
