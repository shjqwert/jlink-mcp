## REMOVED Requirements

### Requirement: Direct RTT channel access uses existing target RTT only
**Reason**: Direct RTT capture is removed as a backend and fallback path.
**Migration**: Use validated DLL HSS for capture; retain explicit RTT logging tools as auxiliaries only.
