# HSS DLL Failure

Failure classification: `HSS_SAFETY_FAIL`.

Observed:

- DLL exists and required `JLINK_HSS_*` exports resolve.
- Experimental env was enabled.
- Base API candidate was authorized and connect-preflight succeeded.
- Probe serial observed: `69401227`.
- `targetWasHalted=true`.
- HSS smoke and benchmark stopped before Start/Read/Stop.

Safety:

- Target write: no.
- Reset/halt/flash: no.
- Motor start: no.
- `bMotorStarted`: not written.
- `capture_control start`: not called.

Blocker: target is halted. Continuing to HSS benchmark would violate the safety gate.
