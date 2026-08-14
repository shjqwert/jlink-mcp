import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const PINNED_HSS_HELPER_RELEASE = {
  version: "2.2.0",
  protocolVersion: 3,
  architecture: "x64",
  sha256: "b3734105aafc19659ac83096eeb2d1d043bbf6c43f6b83ba0134eecfecd724b3",
} as const;

export function matchesPinnedHssHelperManifest(value: Record<string, unknown>): boolean {
  return value.version === PINNED_HSS_HELPER_RELEASE.version
    && value.protocolVersion === PINNED_HSS_HELPER_RELEASE.protocolVersion
    && value.architecture === PINNED_HSS_HELPER_RELEASE.architecture
    && value.sha256 === PINNED_HSS_HELPER_RELEASE.sha256;
}

export function matchesPinnedHssHelperVersion(value: Record<string, unknown>): boolean {
  return value.status === "ok"
    && value.helperVersion === PINNED_HSS_HELPER_RELEASE.version
    && value.helperProtocolVersion === PINNED_HSS_HELPER_RELEASE.protocolVersion
    && value.architecture === PINNED_HSS_HELPER_RELEASE.architecture;
}

export function findPinnedHssHelperPath(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    resolve(__dirname, "..", "..", "native", "hss-helper", "bin", "hss_helper.exe"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => {
    try { return existsSync(candidate) && statSync(candidate).isFile(); }
    catch { return false; }
  });
}
