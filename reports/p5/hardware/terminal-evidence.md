# p5-hardware-r2-r4-v2 终态证据摘要

## 已执行路径

- 生产入口：`C:\Program Files\nodejs\node.exe D:\AI_Project\Trunk\Jlink_mcp\out\mcp\standalone.js`
- 绑定：`targetId=Z20K146M`、`serial=69401227`、`SWD`、`4000 kHz`、`script.mode=none`
- Runtime bundle SHA-256：`980b022d5300dd3267cd3f874679b9d9356f28d230a3181b614c154eb989796d`
- helper SHA-256：`b1626febb191ab16a9fee1d5293b3fea812da3c0f4b91fda5147acf4d1268b91`
- adapter SHA-256：`ad5f7f3c5b6a1cc840e3a0c4adc1f649ef107e96d1dd4c22d1f7a33e58d61f1e`
- OUT SHA-256：`0ab51e0520a7afc2ffe064ac75296670016879958f56842c0e7433270278d5d6`
- MAP SHA-256：`f95d59de4b2b3dcc3ce296069ad5c7d167007d54dea43e01a6284bfdddb2bdaf`
- Artifact generation：`99b1212f878b34a13f0e0dd207ebf866b874ea763f5a8792bf6a08801b967066`

## Trust Profile

- 刷新证据：`runs/2026-07-17T22-09-27-780+08-00/evidence.json`，SHA-256 `3a080739113bc8858fe0b1c60e6c044ce7334d46fe7e82395d1a70381fc70fe9`
- 唯一变更路径：`profileSha256`、`runtime.helperSha256`、`runtime.sha256`
- Profile 文件 SHA-256：`89f69285f25f74115bd23f064e46c6f0c5273f2faeca572841997bff9ae6712c` → `ef7cc209239ce9a30bb18dbaff8dd2a63917c17b657c2d909a58ccdd66f4b2d4`

## HSS 失败包

- Capture ID：`67b996bf-6956-471a-8909-af1933bf8b59`
- Plan ID：`dc20920f-5428-4568-857a-5baf91a567ff`
- `evidence.json`：38,343 bytes，SHA-256 `4644ea4d916be020039bebb8d09e8bc3d5019ea9e3b5d71d6634fcc6041bbe10`
- `audit.jsonl`：18,776 bytes，SHA-256 `f79b8103b8defbfc7595c30b5d138142cf05a1caae5dfed4582b92ea724de62d`
- `plan.json`：4,741 bytes，SHA-256 `96523b02f22068321168285d44163cbdd6a07fe21d30750b4f252705511a9b59`
- `artifact-match-v0.json`：428,418 bytes，SHA-256 `b91facb71fb5d275098f884382ffad73613de1f3d43c13f5cd8351c38201ef85`
- `capture.db`：61,440 bytes，SHA-256 `3b7e00f45b694a6c662a3416427bbefafa82bc003f652704bae60b510391dc7b`
- `raw/events.bin`：4,341 bytes，SHA-256 `c9992acbce46902f9f24b0bec97f3cfc22a857f74d62b813b18c6dae600a4fe9`
- `raw/samples.bin`：0 bytes，SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- JCAP 事件序列仅为 `capture_planned`、`HSS_HELPER_BAD_JSON` fault、`pre_start_failure`；未出现 `hss_start`。

## 边界结果

- R2 写入未调用；R4 plan/challenge/executor 未调用。
- Flash、Erase、reset、halt、resume、R5 计数均为 0。
- 目标工程前后 1,813 文件逐项完全相同，digest 均为 `a366f917c6a2f46da86b5cc4e04d933ffdca4aaf69c4ced8e8817cfeeb911b93`；后验清单 SHA-256 `bb619436058a8b31e66961c91703b44af50482a34567b69917370c136fec6bc0`。
