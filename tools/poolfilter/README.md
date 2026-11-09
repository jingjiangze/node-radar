# poolfilter —— CN 侧公开节点协议级筛选（分块滚动）

本仓库只做「合并公开源 + 发布」。**这些节点在国内能不能用，CI 侧测不出来**（机房视角 ≠ 家宽，单次健康检查本身也不可信）。所以把「验证」放到一台国内常开的机器上，按**小片滚动**测，产物单独发布。

## 链路

```
node-radar（GitHub Actions，约 8–10 分钟一轮）→ dist/clash.yaml
    └─(gcore.jsDelivr)→ 百度 poolfilter：每 10 分钟测一片（CHUNK=120，并发 3）
            ├─ out/results.json  滚动结果（每个节点最近一次实测延迟 + 时间）
            ├─ out/clash.yaml    最近 12h 内测过且通过的节点，按延迟排序
            ├─ out/top20.yaml    给路由器当 provider
            └─ out/stats.json
                 │
   pool.jiangjiangze.icu（cloudflared 隧道 → nginx 127.0.0.1:8899）
                 │
   路由器 poolsync（带重试/校验/原子替换）→ provider「公开池」→ 📺 流媒体
```

**为什么分块**：一次性扫 3,074 个要 16 分钟满载，会抢百度那 2.5Mbps 上行和 CPU；分块后每轮只跑 ~50 秒、并发 3，几乎无感，约 4.3 小时滚动覆盖一遍全池。

## 频率

| 环节 | 频率 |
|---|---|
| node-radar 合并发布 | ~8–10 分钟（continuous chain） |
| 百度分片测试 | **每 10 分钟一片**（`OnCalendar=*:0/10`） |
| 一片的大小 | 120 个（`CHUNK`） |
| 全池轮完 | 约 4.3 小时 |
| 结果有效期 | 12 小时（`RECENT_HOURS`），过期不进产物 |

## 参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHUNK` | 120 | 每轮测多少个 |
| `CONC` | 3 | 并发（故意压低，不抢上行） |
| `TIMEOUT` | 5000 | 单节点超时 |
| `TOP_N` | 20 | 下发给路由器的条数 |
| `RECENT_HOURS` | 12 | 只认最近多少小时的结果 |
| `MIN_PASS` | 30 | 通过数不足就不覆盖产物 |
| `LIMIT` | 0 | 调试：只测前 N 个且不写产物 |
| `PROBE_VIA_HOME` | 0 | 走家宽出口（需反向 SOCKS，默认关闭） |

## 部署

```bash
mkdir -p /opt/poolfilter && cd /opt/poolfilter
npm install --no-audit --no-fund js-yaml
curl -sSLo run.mjs https://raw.githubusercontent.com/jingjiangze/node-radar/main/tools/poolfilter/run.mjs
mkdir -p out mh
cp tools/poolfilter/deploy/poolfilter.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now poolfilter.timer
```

发布侧：nginx 静态块（`deploy/nginx-pool.conf`，只绑 127.0.0.1:8899）+ cloudflared 隧道 ingress `pool.<zone> → http://127.0.0.1:8899`。

⚠️ **百度不放行直连**：80 端口对非备案域名 302 到 `domainwall.cloud.baidu.com`；443 直连+自定义 SNI 会被重置 ⇒ 只能走隧道。

## 备用链路（百度退役后）

**方案 A**：路由器测 + GitHub 发 —— 路由器每晚拉池，TCP 粗筛后协议测（一晚 300–500 个），用只给本仓库 `contents:write` 的 fine-grained PAT 提交 `dist/pool-cn.yaml`。暂未启用。

## 反向 SOCKS（方案保留、默认关闭）

判据：`curl --socks5-hostname 127.0.0.1:11080 https://ifconfig.me` 必须回家庭公网 IP。当前不建议启用（旧 dropbear + OpenSSH 9.9 的残留会话会占端口，见历史记录）。
