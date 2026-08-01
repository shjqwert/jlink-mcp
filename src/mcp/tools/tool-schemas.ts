import { z } from "zod";
import { isValidAcceptanceRunId } from "../acceptance/run-id";

export const projectRootInput = {
  projectRoot: z.string().min(1).describe("Existing absolute engineering project root selected by mcp_init and configured by target_configure"),
};

export const acceptanceRunId = z.string().refine(
  isValidAcceptanceRunId,
  "runId must be a bounded immutable non-reserved directory name",
).describe("Optional Acceptance evidence routing identifier. This is not a general task ID; omit it outside an active Acceptance run.");

export const variableRef = z.string().min(1).max(1024)
  .describe("Logical typed symbol selector; the server re-resolves it against the current Artifact generation");

export const userConfirmation = z.boolean().default(false)
  .describe("Set true only after the user explicitly confirms this exact operation and its effects.");
