import { z } from "zod";
import {
  CaptureQueryOperations,
  type CaptureEventWindowInput,
  type CaptureSeriesInput,
} from "../runtime/capture-query-operations";
import type { RegisterEnvelopeTool } from "./tool-contract";

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
    variables: z.array(z.string().min(1).max(1024)).min(1).max(32),
    startTick: z.string().regex(/^\d+$/),
    endTick: z.string().regex(/^\d+$/),
    bucketCount: z.number().int().min(1).max(4096),
  }, (input) => services.captures.series(input as unknown as CaptureSeriesInput));
  register("capture_event_window", {
    captureId: z.string().uuid(),
    eventId: z.string().uuid(),
    variables: z.array(z.string().min(1).max(1024)).max(16),
    beforeMs: z.number().int().min(0).max(60_000),
    afterMs: z.number().int().min(0).max(60_000),
    bucketCount: z.number().int().min(1).max(2048),
  }, (input) => services.captures.eventWindow(input as unknown as CaptureEventWindowInput));
  register("capture_export_csv", { captureId: z.string().uuid() },
    (input) => services.captures.exportCsv(String(input.captureId)));
}
