# HSS API Evidence Discovery

Conclusion: `HSS_MISSING_PROTOTYPE`.

Searched:

- `C:\Program Files\SEGGER\JLink_V884`
- `C:\Program Files\SEGGER\JLink`
- `C:\Program Files (x86)\SEGGER\JLink`
- `JLINK_INSTALL_DIR`
- `JLINK_SDK_DIR`

Evidence found:

- `JLink_x64.dll` and `JLinkARM.dll` contain `JLINK_HSS_GetCaps`, `JLINK_HSS_Start`, `JLINK_HSS_Read`, and `JLINK_HSS_Stop` strings.
- No `.h`, `.hpp`, `.def`, or text file with typed `JLINK_HSS_*` prototypes was found.
- No calling convention, struct layout, or enum definition was found.

Result:

- Typed prototypes found: no.
- Safe DLL adapter can be implemented: no.
- HSS headless benchmark is blocked; exports/strings are not enough to call the DLL.
