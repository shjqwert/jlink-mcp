export const MCP_RESULT_MODES = ["normal", "full", "text"] as const;

export type McpResultMode = typeof MCP_RESULT_MODES[number];

/** Preserve text-only client compatibility until a structured result mode is selected explicitly. */
export const DEFAULT_MCP_RESULT_MODE: McpResultMode = "text";

export function parseMcpResultMode(value: string | undefined): McpResultMode {
  if (!value) return DEFAULT_MCP_RESULT_MODE;
  if ((MCP_RESULT_MODES as readonly string[]).includes(value)) return value as McpResultMode;
  throw new Error(`Invalid JLINK_MCP_RESULT_MODE: ${value}. Expected ${MCP_RESULT_MODES.join(", ")}`);
}
