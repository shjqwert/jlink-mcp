# Coverage Gap Report

Full repo line coverage is 70.44% after focused HM_C095/write validation tests.

The gap is expected because broad VS Code extension, probe, GDB, RTT, telnet, and hardware-facing modules are outside this offline HM_C095 validation scope.

Scoped gates enforced in this run:

- Runtime analysis modules >=95%
- Write validation modules >=95%
- Backend/router/RTT/TraceAgent modules >=95%

No files were excluded to fake whole-repo coverage.
