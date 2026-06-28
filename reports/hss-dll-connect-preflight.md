# HSS DLL Connect Preflight

Result: connect succeeded, safety failed.

Evidence:

- Device: `Z20K146MC`
- Interface: `SWD`
- Speed: 4000 kHz
- Probe serial observed: `69401227`
- DLL version: `88400`
- Return codes: open/device/interface/connect all `0`

Safety result:

- `targetWasHalted=true`
- `haltIssued=false`
- `resetIssued=false`
- `flashIssued=false`
- `targetWritten=false`

Because the helper detected a halted target, HSS smoke and benchmark were stopped and must not be marked PASS.
