import { z } from "zod";
import { isValidAcceptanceRunId } from "../acceptance/run-id";

export const projectRootInput = {
  projectRoot: z.string().min(1).describe("Existing absolute project root configured by target_configure"),
};

export const acceptanceRunId = z.string().refine(
  isValidAcceptanceRunId,
  "runId must be a bounded immutable non-reserved directory name",
);

export const variableRef = z.string().min(1).max(1024)
  .describe("Logical typed symbol selector; the server re-resolves it against the current Artifact generation");

export const userConfirmation = z.boolean().default(false)
  .describe("Set true only after the user explicitly confirms this exact operation and its effects.");
