export const MCP_PROFILES = ["compact", "advanced", "legacy", "acceptance"] as const;

export type McpProfile = typeof MCP_PROFILES[number];

export const DEFAULT_MCP_PROFILE: McpProfile = "compact";

export function parseMcpProfile(value: string | undefined): McpProfile {
  if (!value) return DEFAULT_MCP_PROFILE;
  if ((MCP_PROFILES as readonly string[]).includes(value)) return value as McpProfile;
  throw new Error(`Invalid JLINK_MCP_PROFILE: ${value}. Expected ${MCP_PROFILES.join(", ")}`);
}

export function usesLegacySurface(profile: McpProfile): boolean {
  return profile === "legacy" || profile === "acceptance";
}
