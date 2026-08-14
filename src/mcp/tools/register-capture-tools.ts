import { z } from "zod";
import {
  CaptureQueryOperations,
  type CaptureEventWindowInput,
  type CaptureSeriesInput,
} from "../runtime/capture-query-operations";
import type { RegisterEnvelopeTool } from "./tool-contract";

const captureTimeRangeSchema = z.object({
  startMs: z.number().finite().nonnegative().optional(),
  endMs: z.number().finite().nonnegative().optional(),
}).strict();

const captureResolutionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("raw") }).strict(),
  z.object({ mode: z.literal("interval"), intervalMs: z.number().finite().positive() }).strict(),
  z.object({ mode: z.literal("points"), maxPoints: z.number().int().min(1).max(4096) }).strict(),
]);

const captureStatisticsSchema = z.array(z.enum(["last", "min", "max"])).min(1).max(3);

export function registerCaptureTools(
  register: RegisterEnvelopeTool,
  services: { captures: CaptureQueryOperations },
): void {
  register("capture_list", {
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  }, (input) => services.captures.list({
    limit: Number(input.limit),
    cursor: input.cursor as string | undefined,
  }));
  register("capture_summary", { captureId: z.string().uuid() },
    (input) => services.captures.summary(String(input.captureId)));
  register("capture_series", {
    captureId: z.string().uuid(),
    variables: z.array(z.string().min(1).max(1024)).min(1).max(16),
    timeRange: captureTimeRangeSchema.optional(),
    resolution: captureResolutionSchema.optional(),
    statistics: captureStatisticsSchema.optional(),
    cursor: z.string().optional(),
    startTick: z.string().regex(/^\d+$/).optional()
      .describe("Legacy inclusive unsigned decimal capture tick; must be less than or equal to endTick and provided with bucketCount only."),
    endTick: z.string().regex(/^\d+$/).optional()
      .describe("Legacy inclusive unsigned capture tick; must be greater than or equal to startTick and provided with bucketCount only."),
    bucketCount: z.number().int().min(1).max(4096).optional(),
  }, (input) => services.captures.series(input as unknown as CaptureSeriesInput));
  register("capture_event_window", {
    captureId: z.string().uuid(),
    eventId: z.string().uuid(),
    variables: z.array(z.string().min(1).max(1024)).max(16),
    beforeMs: z.number().finite().min(0).max(60_000),
    afterMs: z.number().finite().min(0).max(60_000),
    resolution: captureResolutionSchema.optional(),
    statistics: captureStatisticsSchema.optional(),
    cursor: z.string().optional(),
    bucketCount: z.number().int().min(1).max(2048).optional(),
  }, (input) => services.captures.eventWindow(input as unknown as CaptureEventWindowInput));
  register("capture_export_csv", { captureId: z.string().uuid() },
    (input) => services.captures.exportCsv(String(input.captureId)));
}
