# node-radar

自动发现、聚合、审计并发布公开 Clash / Mihomo 节点。公共节点池与自建隧道池保持隔离。

## 自动流程

1. 定时搜索公开 GitHub 订阅源；新源先进入 `sources.candidates.json` 隔离区。
2. 候选源需要连续 3 轮成功、跨越至少 48 小时且每次至少解析出 5 个节点，才晋升到 `sources.auto.json`。
3. 聚合人工策展源和已晋升源，解析协议、校验字段、去重并进行 TCP 端口探测。
4. Mihomo 验证生成的完整订阅与精简订阅。
5. 从抽样节点逐个切换 Mihomo 代理，访问 Cloudflare Trace，记录真实出口 IP、Cloudflare colo、国家与 WARP 标志。
6. 对节点端点 IP 和代理实际出口 IP 查询 ASN / 网络归属 / 机房信号，生成 CF 与数据中心审计报告。
7. 所有门禁通过后，Actions 自动提交订阅和报告到 `main`；失败时保留上一版，不发布本轮产物。

## 产物

| 文件 | 用途 |
|---|---|
| `dist/clash.yaml` | 全量公开节点池 |
| `dist/clash-lite.yaml` | 地区分层精简池 |
| `dist/speed-top.yaml` | 实测高速节点（达到最低数量时生成） |
| `dist/summary.json` | 源、协议、地区和存活汇总 |
| `dist/egress-audit.json` | 代理真实出口审计记录 |
| `dist/cf-egress.json` | 被证据确认的 CF/WARP 出口节点 |
| `dist/cf-fronted-endpoints.json` | 节点端点位于 Cloudflare 网络的候选 |
| `dist/cf-egress.yaml` | 有真实出口证据的 CF 专项订阅（样本池，不代表全量） |
| `dist/datacenter-audit.json` | 节点端点 / 出口 IP 的数据中心信号 |
| `dist/ip-meta-cache.json` | IP 归属元数据缓存，减少重复查询 |

## CF 分类口径

- `cloudflare-warp-egress`: Cloudflare Trace 的 `warp=on`，表示请求经过 WARP。
- `cloudflare-owned-egress-ip`: 实际出口 IP 的 ASN 为 AS13335 或归属证据明确指向 Cloudflare。
- `cloudflare-edge-observed-egress-owner-unconfirmed`: Trace 返回 Cloudflare colo；只证明访问 Cloudflare 时观察到了该边缘节点，不证明出口 IP 属于 Cloudflare。
- `cf-fronted-endpoints`: 节点配置的服务器域名解析到 Cloudflare 网络；这只是入口 / 前置代理证据，不等于代理实际出口属于 CF。

不能把 CF 的 Anycast colo、CF 反向代理入口和节点的真实出口 IP 混为一谈。Cloudflare 官方说明可通过 Trace 的 `colo` 识别处理请求的 PoP，但 colo 本身不说明源站或出口 IP 的所有权。

## IP / 机房审计

默认使用 ipapi.is 匿名查询，按运行缓存并限制每轮新增查询数；匿名模式不提供完整的机房 / VPN / 代理检测标志。可选配置仓库 Actions Secret `IPAPI_KEY`，使用免费额度增强 ASN、公司类型和数据中心识别。不要把 API Key 写入仓库文件。

机房分类使用 ASN / 公司类型和网络归属证据；无完整数据时标记为信号或未知，不将地理定位城市直接当作机房地址。RDAP / ASN 注册归属与实际物理机房位置不是同一概念。

## 重要边界

- GitHub Actions Runner 位于美国，测速与 CF Trace 结果只代表该 Runner 的网络视角，不代表中国大陆、亚洲或用户本地出口。
- CF Trace 返回的出口 IP 是当前代理链路对 Cloudflare 可见的 IP；若节点再套上游代理、WARP 或 NAT，结果对应最终出口，不一定是节点服务器自身 IP。
- 数据中心标记是 IP 数据库的分类结果 / 启发式信号，不是机房实地核验。
- 公开订阅可能失效或包含恶意配置。只解析并运行受限抽样节点；不要在本机生产环境直接导入未经检查的配置。
- 本仓库不托管自建节点，不接入 edgetunnel-ops 的私有隧道池。

## 手动运行

在 Actions 中运行 `aggregate-nodes`、`discover-sources` 或 `speedtest`。聚合工作流的最终发布仍受 Mihomo 配置校验和出口审计门禁控制。

## 许可

本项目以 **GNU General Public License v3.0 或更新版本**（`GPL-3.0-or-later`）发布，全文见 [`LICENSE`](LICENSE)。

Copyright (C) 2026 jingjiangze

可以自由使用、修改与再分发；但**分发衍生作品时必须同样以 GPL-3.0-or-later 开源**，并提供对应源代码。本程序不提供任何担保。
