# 归档（不会被 GitHub Actions 加载）

`scripts/` 与 `.github/workflows/` 的根目录才是生效的；这里只做留档，随时可以改回去。

## 工作流

| 文件 | 原用途 | 停用原因 |
|---|---|---|
| `pipeline.probe-speedtest.yml.txt` | 含国内探测 + CI 测速的完整流水线 | 单次健康检查不可信、两层烧额度 |
| `speedtest.yml.txt` | 独立测速（手动） | 同上 |
| `cn-probe.yml.txt` | 独立国内探测（手动） | 同上 |

## 脚本

| 文件 | 原用途 |
|---|---|
| `scripts/cn-probe-gp.mjs` / `cn-probe.mjs` / `merge-probes.mjs` | Globalping 国内可达性探测与分片合并 |
| `scripts/speedtest.mjs` / `rerank.mjs` | 抽样实测下载速度与按速度重排 |
| `scripts/cn-verify.mjs` / `verify.mjs` / `hk-probe.mjs` | 一次性验证脚本 |
| `scripts/audit-egress.mjs` | 出口 IP / ASN 审计（手动） |

## 恢复注意

- `aggregate.mjs` 仍会在 `dist/cn-probe.json`、`dist/speed.json` 存在且 ≤36h 时参考它们；这两个文件已删除，所以现在走「无 CN 数据」分支。
- 恢复任何一个脚本前，先确认它引用的产物路径还在。
