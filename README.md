# CPA Usage

**本地优先，轻量运行。** A local-first, lightweight **CLIProxyAPI plugin** for token usage analytics.

- **本地优先**：用量数据保存在本机 SQLite，不上传第三方分析平台；插件仅随你的 CLIProxyAPI 运行。
- **实时采集**：通过 `usage.handle` 插件回调，请求完成的瞬间写入数据库——无轮询、无队列窗口、不丢数据。
- **零额外进程**：原生动态库（`.dylib` / `.so`）运行在 CPA 进程内，无需 Python、Node.js、Docker 或独立服务。
- 真实 shadcn/ui 界面：Token 趋势、模型 / 匿名 Key / 请求明细与筛选。

**状态：v0.3.5 / CLIProxyAPI 7.x / macOS、Linux 与 Windows。MIT 开源。**

## 安装

### 插件商店（推荐）

1. 在 `cliproxyapi.conf` 中添加插件商店源与插件配置：

```yaml
plugins:
  enabled: true
  store-sources:
    - "https://raw.githubusercontent.com/ting1e/cpa-usage/main/plugin-store/registry.json"
  configs:
    usage-report:
      enabled: true
      db_path: "~/.cli-proxy-api/usage-report/usage.sqlite"
```

2. 重启 CLIProxyAPI，打开管理面板 → **插件商店** → 找到 **CPA Usage Report** → 安装。
3. 登录 CPA 管理中心并勾选“记住密码”，打开 **插件 → Usage Report**（或访问 `/v0/resource/plugins/usage-report/report`）；页面复用同源管理中心会话访问受保护的插件 API。

> 此源提供 `ting1e/cpa-usage` 分支版本，包含 TPS、总耗时与 TTFT 统计。若已使用原作者的商店源，请替换该源（其他插件商店源可保留），避免两个源中的同名 `usage-report` 指向不同仓库；在插件商店刷新并更新至 **0.3.5**，重启 CPA。保留原 `db_path` 和 SQLite 数据库，不要删除历史数据。确保数据库父目录已存在且 CPA 运行用户有写权限。Docker 部署时，数据库路径应位于持久化挂载目录。

> CPA 访问 GitHub API 查插件信息有匿名频率限制；若遇到 rate limit，可为 CPA 进程配置 `GITHUB_TOKEN` 环境变量，并在 `plugins.store-auth` 添加 `type: github-token`、`token-env: GITHUB_TOKEN` 的规则。

### 手动安装（离线）

从 [Releases](https://github.com/ting1e/cpa-usage/releases) 下载对应平台的 `usage-report_{version}_{goos}_{goarch}.zip`，解压后放入插件目录：

```bash
unzip usage-report_0.3.5_darwin_arm64.zip
mkdir -p <plugins-dir>/darwin/arm64
cp usage-report-v0.3.5.dylib <plugins-dir>/darwin/arm64/
# Linux 为 .so，目录名相应为 linux/amd64 或 linux/arm64
```

或从源码构建：

```sh
cd plugin
go build -buildmode=c-shared -o usage-report.dylib .   # macOS；Linux 产物为 .so
```

## 使用

- 页面：`/v0/resource/plugins/usage-report/report`
- 数据 API（需认证）：`/v0/management/plugins/usage-report/api/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&bucket=day|hour|month`，请求头 `Authorization: Bearer <管理密钥>`
- 任何经过该 CPA 实例的请求（Codex CLI、OpenCode、其他客户端）都会自动记录。

界面能力：

- 今天、近 7/30 天与自定义日期范围；模型筛选同时作用于 KPI、趋势和明细。
- 缓存输入 / 净输入 / 输出堆叠趋势，小时 / 天 / 月粒度。
- 模型、匿名 Key、请求三个视角；搜索、排序与分页。
- 全部请求参与成功率统计，包括零 Token 失败；输入含缓存，输出含推理，不重复相加。
- 输出 TPS、平均总耗时与平均首 Token 延迟（TTFT）；模型 / Key 聚合和请求明细均展示，支持按聚合 TPS / 总耗时降序排序。
- 错误、空数据与采集异常明确显示，不把空白或旧数据当实时成功。
- 按模型显示可编辑的 API 等价费用（美元），未知模型不按零元处理；不把等价费用伪装成订阅实际账单。

性能指标口径：

- **TPS（Token/s）**：输出 Token ÷ 生成耗时（秒），生成耗时 = 总耗时 − TTFT。TTFT 未上报（零值或缺失）时使用总耗时；失败、无输出、缺失或无效耗时不参与。输出已包含推理，不额外相加。
- **总体 / 模型 / Key TPS**：有效请求的输出 Token 总和 ÷ 生成耗时总和，非单请求 TPS 的算术平均，也不是并发请求的系统吞吐量。
- **平均总耗时**：成功和失败请求中有效总耗时的算术平均；**平均 TTFT**：大于零且不超过总耗时的有效首 Token 延迟的算术平均。页面耗时单位为秒，API 的 `latency_ms` / `ttft_ms` 单位仍为毫秒，事件新增 `tps` 字段，无有效数据时为 `null`。
- 已有 SQLite 记录直接按保存的耗时计算，无需迁移；未保存耗时的历史请求显示“暂无”或 `—`，不作为零值参与平均。

### Codex 5h / 周额度估算与金额

此功能需要 **CPA 8.x** 在 `usage.handle` 中上报 `AuthID` / `AuthIndex` 和包含额度信息的 `ResponseHeaders`。不主动轮询账户、不读取或保存账号访问令牌，只记录本机经过 CPA 的用量与白名单额度字段。额度按响应头的实际 `window-minutes`（300 / 10080）识别，不假设 primary 永远是 5h；旧记录缺少这些信息时无法追溯补算。

- **账号剩余快照**：展示最后一次请求观察到的全账号剩余百分比、观察时间和重置时间。该值包含外部软件的使用，不是 CPA 独占余额；过期后明确提示需发起请求刷新。
- **活跃期观察变化**：仅使用同匿名账号、同模型 / 服务层、同周期内连续串行请求的非负额度差值。首个请求只建立基线，间隔超过 5 秒、并发、失败、缺字段、时间乱序、额度回退或重置不产生有效扣减样本。最近 30 天的数据参与分析，不随上方日期 / 模型筛选截断。
- **本周期 CPA 估计消耗**：至少 2 个有效区间且累计额度变化大于零后，按 `样本累计百分点 / 样本 API 等价 USD` 学习系数，仅外推该账号当前周期中同模型 / 服务层的 CPA 请求。其他模型不会套用该系数；历史数据不完整时只覆盖已保存的请求，不是整个周期的完整账本。
- **100% / 剩余额度等价 USD**：按上述系数估算整窗容量及上次观察的剩余容量，并按样本的输入 + 输出 Token 配比估算可用 Token，只适用于当前模型 / 服务层，不是官方额度价格、现金余额或订阅价值。首个请求可能已有额度消耗，百分比有精度限制，HTTP 额度头也可能早于生成结束；这些因素及请求 Token 配比变化均会带来误差。
- **重要归因限制**：空闲时段外部软件导致的额度变化不累计；但同账号外部 Codex **在 CPA 活跃期同时使用**时，仅凭服务端账号快照无法区分，仍可能污染样本。页面始终提示这一限制，不承诺完全排除外部消耗。

API 等价费用 = `(净输入 × input + 缓存读取 × cache + 输出 × output) / 1,000,000`。输出已包含推理，不重复相加；失败请求若有有效 Token 仍计算等价费用。默认价格来自 [OpenAI 官方 API 价格](https://developers.openai.com/api/docs/pricing)，核对日期 **2026-10-13**，采用 Standard 短上下文文本价；不自动计入长上下文、Fast / Ultrafast、工具、图片或缓存写入附加费用。可在 **模型单价**中编辑 JSON（单位 USD / 百万 Token），设置别名或自定义价格，保存在当前浏览器。价格缺失时明确标注未定价 / 部分合计，不把未知模型当成免费。

## 配置

| 字段 | 说明 |
|---|---|
| `plugins.configs.usage-report.enabled` | 是否启用插件 |
| `plugins.configs.usage-report.db_path` | SQLite 路径，默认 `~/.cli-proxy-api/usage-report/usage.sqlite` |
| `plugins.store-sources` | 插件商店 registry 地址（安装/更新用） |

## 数据与安全

- 用量事件保存在 `db_path` 指向的本地 SQLite（表 `usage_events`），页面 API 在返回前将 Key 转换为稳定的匿名分组（`key-xxxxxxxxxx` 或 `未知 Key`）。
- 账号标识保存在本机，返回前转换为 `account-xxxxxxxxxx`；不向前端返回原始 AuthID / AuthIndex。上游响应头只保留额度数值和已知套餐类型，不保存 Authorization、Cookie 或任意响应头。
- 原始事件仅保存在本地，可能包含客户端 Key；不要将数据库公开上传。
- 插件的资源页面无独立鉴权，仅在 CPA 管理域内可达；请勿将 CPA 管理端口暴露到公网。

## 开发

```sh
cd plugin
GOPROXY=https://goproxy.cn,direct go test ./...       # 单元测试
go build -buildmode=c-shared -o usage-report.dylib .  # macOS；Linux 为 .so
```

页面资源位于 `plugin/web/`，来自本仓库 `frontend/` 的构建产物：

```sh
cd frontend && npm ci && npm run build
cp dist/index.html ../plugin/web/index.html
cp dist/assets/* ../plugin/web/assets/
```

> 替换前端后需同步更新 `plugin/main.go` 中 embed 的文件名与 `management.register` 的资源路由（构建产物带 hash 文件名）。

### 发布新版本

版本号存于 `VERSION`，与 git tag（`v{version}`）一致。推送 tag 即触发 Release 流水线：五个平台（darwin/arm64、darwin/amd64、linux/amd64、linux/arm64、windows/amd64）构建插件并注入版本号、生成 `checksums.txt` 并发布 Release。

```sh
# 1. 更新 VERSION、CHANGELOG.md，提交并合并到 main
# 2. 打 tag 推送，流水线自动发布
git tag v0.3.5
git push origin v0.3.5
# 3. 更新插件商店 registry 中的 version 字段
```

## License

[MIT](LICENSE)。界面组件基于 [shadcn/ui](https://github.com/shadcn-ui/ui)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
