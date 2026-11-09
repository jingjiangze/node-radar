# poolfilter —— CN 侧公开节点协议级筛选

本仓库只做「合并公开源 + 发布」。**这些节点在国内能不能用，CI 侧测不出来**（机房视角 ≠ 家宽，而且单次健康检查本身不可信）。所以把「验证」这一步放到一台国内常开的机器上，产物单独发布。

## 链路

```
node-radar（GitHub Actions，合并）
   └─ dist/clash.yaml  ──(gcore.jsDelivr)──►  百度服务器 poolfilter（每天 04:00）
                                                ├─ 临时 mihomo：逐节点 /delay 测真实请求
                                                ├─ out/clash.yaml   （通过的节点，按延迟排序）
                                                ├─ out/top20.yaml   （给路由器当 provider）
                                                └─ stats.json
                                                     │
                                        pool.jiangjiangze.icu（cloudflared 隧道 → nginx 静态）
                                                     │
                                     路由器 provider「公开池」→ 组 📺 流媒体
```

## 环境要求

- 一台国内常开的 Linux（本项目用的是百度云 2 vCPU / 3.9G）
- 已安装 mihomo（默认 `/opt/mihomo/mihomo`）
- Node ≥ 18
- **出口能到 jsDelivr 的 gcore 节点**（`raw.githubusercontent.com` 在国内直连不通；`gcore.jsdelivr.net` 实测 2.4s 下完 966KB）

## 部署

```bash
mkdir -p /opt/poolfilter && cd /opt/poolfilter
npm install --no-audit --no-fund js-yaml
curl -sSLo run.mjs https://raw.githubusercontent.com/jingjiangze/node-radar/main/tools/poolfilter/run.mjs
mkdir -p out mh

cp tools/poolfilter/deploy/poolfilter.service /etc/systemd/system/
cp tools/poolfilter/deploy/poolfilter.timer   /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now poolfilter.timer
```

对外发布（静态 + 隧道，不需要证书）：

```bash
mkdir -p /etc/nginx/conf.d
cp tools/poolfilter/deploy/nginx-pool.conf /etc/nginx/conf.d/pool.conf
nginx -t && nginx -s reload
# cloudflared 隧道加一条 ingress：pool.<zone> → http://127.0.0.1:8899
```

## 参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `POOL_SRC` | gcore jsDelivr 的 `dist/clash.yaml` | 池子地址 |
| `TOP_N` | 20 | 给路由器用的 topN 条数 |
| `CONC` | 8 | 并发；2 vCPU 不要再加 |
| `TIMEOUT` | 5000 | 单节点超时 ms |
| `LIMIT` | 0 | >0 只测前 N 个，**调试用、不写产物** |
| `MIN_PASS` | 30 | 通过数低于它就**不覆盖**旧产物（避免一次失败把池子清空） |
| `PROBE_VIA_HOME` | 0 | 走家宽出口（需要路由器反向 SOCKS，见下） |

## 备用链路：百度退役后怎么跑

**方案 A（推荐，暂不启用）**：路由器量 + GitHub 发

1. 路由器每晚 04:00 拉 `dist/clash.yaml`；
2. 先用 TCP 探活粗筛（armv5 上 0.2s/个），再过 `mihomo` 做协议级测试 —— 一晚只能测 **300–500 个**，所以必须两段式；
3. 用一把**只给本仓库 `contents:write`** 的 fine-grained PAT，把结果提交成 `dist/pool-cn.yaml`；
4. 客户端经 jsDelivr / raw 取用。

不选另外两条：GitHub Actions / CF Worker cron 自测都是机房或 CF 边缘视角，测出来的「可用」对家宽没有意义（已有实测反例）。

## 反向 SOCKS（方案保留、默认关闭）

让「家宽视角」参与筛选的做法：路由器开一个 **只绑 127.0.0.1、`proxy: DIRECT`** 的 socks listener，用 `dbclient -R` 反代到本机，节点加 `dialer-proxy` 指向它。

**当前不建议启用**：旧版 dropbear + OpenSSH 9.9 下，残留 sshd 会话会占住远端端口，新连接报 `Remote TCP forward request failed`，必须手工 kill 残留会话才能恢复。判据（如果以后要开）：

```bash
curl --socks5-hostname 127.0.0.1:11080 https://ifconfig.me   # 必须返回家庭公网 IP
```
