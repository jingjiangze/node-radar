# 已停用的工作流（存档，不会被 GitHub Actions 加载）

GitHub 只加载 `.github/workflows/` **根目录**下的 `.yml/.yaml`，子目录不参与调度，
所以这里的文件是「保存流程」的存档：随时可以改名放回根目录恢复。

| 文件 | 原用途 | 停用原因（2026-11-09） |
|---|---|---|
| `pipeline.probe-speedtest.yml.txt` | 含国内探测（Globalping 8 分片）+ CI 实测测速的完整流水线 | 单次健康检查不可信（同一节点 1.2s ↔ 超时摆动），且探测/测速两层烧额度 |
| `speedtest.yml.txt` | 独立测速工作流（手动触发） | 同上 |
| `cn-probe.yml.txt` | 独立国内可达性探测（手动触发） | 同上 |

当前流水线只剩 `pipeline.yml`：源清单刷新 → 合并公开订阅源 → `mihomo -t` 校验 → 发布 → 冒烟 → dispatch 下一轮。

恢复方法：把对应 `.txt` 改回 `.yml` 放回根目录，并按 `pipeline.probe-speedtest.yml.txt` 还原 job 与 `needs` 关系。
