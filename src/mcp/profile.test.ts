import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpProfile, usesLegacySurface } from "./profile";

test("MCP profile parsing defaults to compact and rejects unknown values", () => {
  assert.equal(parseMcpProfile(undefined), "compact");
  for (const profile of ["compact", "advanced", "legacy", "acceptance"] as const) {
    assert.equal(parseMcpProfile(profile), profile);
  }
  assert.throws(() => parseMcpProfile("wide"), /Invalid JLINK_MCP_PROFILE/);
  assert.equal(usesLegacySurface("legacy"), true);
  assert.equal(usesLegacySurface("acceptance"), true);
  assert.equal(usesLegacySurface("compact"), false);
});
