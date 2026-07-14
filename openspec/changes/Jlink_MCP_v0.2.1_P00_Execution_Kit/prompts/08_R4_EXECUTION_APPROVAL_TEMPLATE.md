# 提示词：未来 R4 执行时的人工确认模板

> 仅在工具已经生成 R4 plan，且你确实愿意执行该具体操作时使用。不要提前长期授权。

```text
我确认执行下面这个单次 R4 operation plan：

operation: <flash_write|erase|raw_gdb|raw_probe|critical_svd_write|composite_reset>
planId: <PLAN-ID>
planDigest: <SHA-256>
targetId: <TARGET-ID>
artifactSha256: <SHA-256-or-null>
policySha256: <SHA-256>
expiresAt: <ISO-8601>
expectedImpact: <摘要>
recoveryAndValidation: <摘要>

仅批准以上精确 plan 的一次执行。任何参数、target、artifact、policy、runtime identity、TTL 或 digest 变化都必须重新请求确认。禁止把本消息解释为 approved=true、通用授权或后续操作授权。
```
