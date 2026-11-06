# Node Radar：自动合并与 CF 出口 / 机房 IP 审计方案

日期：2026-11-06

## 现状与风险

现有链路已经包含公开源发现、协议解析、去重、TCP 端口探测、Mihomo 配置生成和 Runner 出口测速，但存在几个语义缺口：

- TCP connect 只能证明目标端口接受连接，不等于代理认证或转发成功。
- 节点名称中的国家 / 城市是用户可控标签，不能作为 IP 地理位置证据。
- Cloudflare Trace 的 colo 代表处理请求的 Cloudflare PoP；它不是代理出口 IP 的所有权证明。
- 端点 IP、CF 代理入口 IP、代理实际出口 IP 是三个不同对象。
- 自动发现源一次性通过“节点数”校验就进入正式源列表，污染面偏大。

## 新的状态机

`DISCOVERED -> CANDIDATE -> REPEATEDLY_VALIDATED -> PROMOTED -> AGGREGATED -> PROBED -> EGRESS_AUDITED -> PUBLISHED`

- 新源进入 `sources.candidates.json`，不直接进入生产聚合。
- 连续 3 次发现运行成功、跨度至少 48 小时、每轮至少解析 5 个节点后，才晋升到 `sources.auto.json`。
- 候选保留 90 天；过期候选不再晋升。
- 已人工策展的 `sources.json` 保留人工控制，不受自动源健康度剔除影响。
- 聚合和测速等写仓库工作流共享并发组，避免相互覆盖。

## CF 出口证据层级

| 分类 | 证据 | 可以得出的结论 |
|---|---|---|
| CF WARP 出口 | 通过 Mihomo 节点请求 CF Trace，返回 `warp=on` | 请求路径使用 Cloudflare WARP |
| CF 自有出口 IP | 实际出口 IP 的 ASN / 公司归属为 Cloudflare（通常 AS13335） | 最终出口 IP 属于 Cloudflare 网络 |
| CF Edge observed | Trace 返回 `colo` | 请求被某 Cloudflare PoP 处理；不代表出口 IP 属于 Cloudflare |
| CF-fronted endpoint | 节点配置的 server 域名解析到 Cloudflare ASN / 网段 | 节点入口前置了 CF；不代表最终出口属于 CF |

每条记录保留出口 IP、colo、warp、国家、ASN、网络归属、端点解析 IP 和采样时间。报告中不输出订阅 URI 或明文节点凭据。

## 机房 / IP 归属审计

每轮抽样：
1. 对配置中的 server 域名做 DNS 解析，排除私网、保留地址和非全球单播地址。
2. 对端点 IP 与代理实际出口 IP 做 ASN / 公司归属查询。
3. 结合公司类型、ASN 类型、网络名称、数据中心数据库标志识别 hosting / cloud / colo 信号。
4. 保留原始证据字段与查询时间；信息缺失时使用 unknown，不凭节点名猜测。
5. 端点 IP 归属与最终出口 IP 归属分别记录，不能互相代替。

IP 元数据使用 ipapi.is。匿名查询仅提供较少字段且有每日请求上限，因此使用本地仓库缓存并限制匿名模式新增查询数。配置可选 Actions Secret `IPAPI_KEY`，免费额度可以提供更多数据中心与 VPN / Proxy 标志。密钥只通过 Actions Secret 注入。

## 代理实际转发验证

- 使用 Mihomo 的本地 API 逐个切换抽样节点。
- 通过代理请求 HTTPS Cloudflare Trace，必须成功返回 `ip` 和 `colo` 才算出口验证通过。
- 这比 TCP 端口探测强，但仍只证明从 GitHub Runner 这一观察点的单次转发成功。
- 节点可能是多跳、上游代理或 WARP 链路，报告描述的是最终可见出口，不推断节点机器的真实物理位置。

## 自动发布 / 自动合并

本仓库当前的生产发布模型是 CI 校验后由 GitHub Actions Bot 直接提交生成订阅和审计报告到 `main`，而不是每轮节点数据都创建 PR。发布门禁包括：

- 聚合产物存在且非空；
- egress 审计脚本必须成功启动 Mihomo；
- 最低数量样本必须完成真实代理转发；
- Mihomo `-t` 对全量、精简和 CF 专项配置执行语法验证；
- 通过后才提交本轮订阅和报告；
- 任一关键门禁失败，workflow 不执行发布步骤，线上上一版保留。

代码本身仍通过 PR 审查合入；自动节点数据的晋升与订阅发布才是无人值守自动流程。不要把自动数据发布理解为自动合并未经审查的代码。

## 当前限制与下一步

1. GitHub Runner 的网络视角偏美国；若要获得地域结论，需要后续增加多个合法自有测试 vantage（例如用户本机主动上传匿名测试结果），而不是把单个 Runner 结果外推到全球。
2. 匿名 IP 元数据受每日查询额度限制；配置 IPAPI_KEY 后可覆盖更多不同 IP。
3. 机房信号不等于物理机房证明。要更精确，可增加多源交叉验证：RIR RDAP、ASN/BGP、PTR、云厂商官方 IP ranges。
4. 当前 egress audit 是抽样审计，不是对数千个节点全量代理转发测试；需要按类型 / ASN / 地区 / CF 特征分层扩大样本。
5. 当前 CF 专项订阅只收集已实证的 CF/WARP 出口样本，不把仅观察到 CF colo 的节点混入。
6. 公开节点来源的安全性无法由格式校验保证；应继续增加源信誉、恶意配置静态规则和节点生命周期评分。

## 参考资料

- Cloudflare：Trace / colo 用于识别处理请求的 PoP：https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/gathering-information-for-troubleshooting-sites/
- Cloudflare：Anycast 路由并不保证地理最近 PoP：https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/
- RFC 9082：RDAP IP / ASN 查询格式：https://www.rfc-editor.org/rfc/rfc9082.html
- RFC 9224：RDAP Bootstrap 服务发现：https://www.rfc-editor.org/rfc/rfc9224.html
- ipapi.is：IP / ASN / hosting 数据字段及匿名请求限制：https://ipapi.is/developers.html
