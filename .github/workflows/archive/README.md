# 已停用的工作流（存档，不会被 GitHub Actions 加载）

GitHub 只加载 `.github/workflows/` **根目录**下的 `.yml/.yaml`，子目录不参与调度，
所以这里的文件是「保存流程」的存档：随时可以改名放回根目录恢复。

| 文件 | 原用途 | 停用原因（2026-11-09） |
|---|---|---|
| `pipeline.probe-speedtest.yml.txt` | 含国内探测（Globalping 8 分片）+ CI 实测测速的完整流水线 | 单次健康检查不可信（同一节点 1.2s ↔ 超时摆动），且探测/测速两层烧额度 |
| `speedtest.yml.txt` | 独立测速工作流（手动触发） | 同上 |
| `cn-probe.yml.txt` | 独立国内可达性探测（手动触发） | 同上 |
| `aggregate.yml.txt` | 独立的聚合发布工作流（手动排障用） | 2026-11-10 与 `pipeline.yml` 的 aggregate job 完全重复，且校验 `dist/speed-top.yaml`（该产物已不再生成）⇒ 两处口径漂移，统一到 `pipeline.yml` + `scripts/ci/validate-dist.mjs` |
| `discover.yml.txt` | 每周一的 GitHub 仓库发现（`scripts/discover.mjs`） | 2026-11-10 其能力已被 `discovery.yml` 的 `github-search` 适配器覆盖；两个工作流都写 `sources.auto.json`，合并为单一写者 |

当前工作流只剩四个：`pipeline.yml`（每 10 分钟：源清单刷新 → 合并 → 校验 → 发布 → 冒烟 → 接续）、`discovery.yml`（每周二：多渠道发现）、`ci.yml`（PR/推送：语法 + 单测 + 夹具回归 + 产物结构/内核校验）、`watchdog.yml`（每 3 小时查最近一次成功运行）。校验口径统一在 `scripts/ci/validate-dist.mjs`，mihomo 安装统一在 `.github/actions/setup-mihomo`。

恢复方法：把对应 `.txt` 改回 `.yml` 放回根目录，并按 `pipeline.probe-speedtest.yml.txt` 还原 job 与 `needs` 关系。
