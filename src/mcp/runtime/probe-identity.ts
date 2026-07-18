export class ProbeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeIdentityError";
  }
}

/** Canonical J-Link USB serial used by configuration, queue keys, and Native APIs. */
export function canonicalProbeSerial(value: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    throw new ProbeIdentityError("Probe serial must be a non-zero unsigned 32-bit decimal J-Link serial");
  }
  let serial: bigint;
  try { serial = BigInt(trimmed); } catch { throw new ProbeIdentityError("Probe serial is not a valid decimal integer"); }
  if (serial < 1n || serial > 0xffff_ffffn) {
    throw new ProbeIdentityError("Probe serial must be in the range 1..4294967295");
  }
  return serial.toString(10);
}
