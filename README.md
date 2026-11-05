# node-pool-aggregator

定时抓取多个**公开**节点源，解析 → 去重 → 输出一份 Clash 订阅。仅做格式转换与去重，不做存活探测。

## 数据源

见 `sources.json`（6 个，均已实测可用）。其中 `chengaopan/AutoMergePublicNodes` 与 `peasoft/NoMoreWalls` 内容字节完全一致，属同一份镜像，只保留一个。

## 产出

- `dist/clash.yaml` —— Clash/Mihomo 订阅
- `dist/summary.json` —— 各源抓取数量与协议分布

## 私有交付（二选一或都用）

1. **Actions Artifact**：每次运行的 `subscription` 产物，仅仓库有权限者可下载。本地用 `gh run download -n subscription` 取回。
2. **Secret Gist**（可选）：在仓库里配置 `GIST_ID` 与 `GIST_TOKEN` 两个 secret 后，CI 会把产出推到那个 secret gist，得到一个不公开索引的 URL，可直接填进 Clash。

## 说明

- 公共节点质量参差、随时失效，且**与自建隧道无关**（UUID 不通）。建议作为独立 profile，不要与自己的隧道混用。
- 本仓库不托管任何节点，只做公开源聚合；请遵守各来源仓库的许可与所在地法规。
