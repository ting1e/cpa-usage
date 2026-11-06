# CPA Usage

**本地优先，轻量运行。** A local-first, lightweight **CLIProxyAPI plugin** for token usage analytics.

- **本地优先**：用量数据保存在本机 SQLite，不上传第三方分析平台；插件仅随你的 CLIProxyAPI 运行。
- **实时采集**：通过 `usage.handle` 插件回调，请求完成的瞬间写入数据库——无轮询、无队列窗口、不丢数据。
- **零额外进程**：原生动态库（`.dylib` / `.so`）运行在 CPA 进程内，无需 Python、Node.js、Docker 或独立服务。
- 真实 shadcn/ui 界面：Token 趋势、模型 / 匿名 Key / 请求明细、性能指标、费用与 Codex 配额。

**版本：v0.4.3（基于上游 v0.4.0）/ CLIProxyAPI 7.x 与 8.x（Codex 配额需 8.x）/ macOS、Linux 与 Windows。MIT 开源。**

> v0.4.2 以上游 v0.4.0 的价格引擎为基础，增量合并本分支的 TPS、延迟 / TTFT、Codex 多账户配额与配额历史。价格、费用和配额估算统一使用后端计算结果。

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

> **CPAMC 登录兼容**：页面同时支持 CPAMC v1（Host + User-Agent 密钥）、CPAMC v2（仅 Host 密钥，v1.27.0+）和明文 JSON 三种记住密码格式。升级到 CPAMC v1.27.0 后更换浏览器 User-Agent 仍可读取 v2 会话；缺失或损坏的登录信息会提示重新登录，不会绕过认证。

> 此源提供 `ting1e/cpa-usage` 分支版本，包含上游 v0.4.0 价格系统以及 TPS、总耗时、TTFT、Codex 多账户配额与配额历史。若已使用原作者的商店源，请替换该源（其他插件商店源可保留），避免两个源中的同名 `usage-report` 指向不同仓库；在插件商店刷新并更新至 **0.4.2**，重启 CPA。保留原 `db_path` 和 SQLite 数据库，不要删除历史数据。确保数据库父目录已存在且 CPA 运行用户有写权限。Docker 部署时，数据库路径应位于持久化挂载目录。

> CPA 访问 GitHub API 查插件信息有匿名频率限制；若遇到 rate limit，可为 CPA 进程配置 `GITHUB_TOKEN` 环境变量，并在 `plugins.store-auth` 添加 `type: github-token`、`token-env: GITHUB_TOKEN` 的规则。

### 手动安装（离线）

从 [Releases](https://github.com/ting1e/cpa-usage/releases) 下载对应平台的 `usage-report_{version}_{goos}_{goarch}.zip`，解压后放入插件目录：

```bash
unzip usage-report_0.4.3_darwin_arm64.zip
mkdir -p <plugins-dir>/darwin/arm64
cp usage-report-v0.4.3.dylib <plugins-dir>/darwin/arm64/
# Linux 为 .so，目录名相应为 linux/amd64 或 linux/arm64
```

或从源码构建：

```sh
cd plugin
go build -buildmode=c-shared -o usage-report.dylib .   # macOS；Linux 产物为 .so
```

## 使用

- 页面：`/v0/resource/plugins/usage-report/report`
- 数据 API（需认证）：`/v0/management/plugins/usage-report/api/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&bucket=day|hour|month`，请求头 `Authorization: Bearer <管理密钥>`。事件包含 `model`、`response_model`、`tps`、`latency_ms`、`ttft_ms`、`cost` 等字段，并单独返回最近 30 天的 `quota_events`。
- 价格 API（需认证）：`GET /v0/management/plugins/usage-report/api/pricing`、`POST /api/pricing`、`POST /api/pricing/refresh`
- 任何经过该 CPA 实例的请求（Codex CLI、OpenCode、其他客户端）都会自动记录。

界面能力：

- 今天、近 7/30 天与自定义日期范围；模型筛选同时作用于 KPI、趋势和明细。
- 缓存输入 / 净输入 / 输出堆叠趋势，小时 / 天 / 月粒度；可切换 Token / 费用趋势。
- 模型、匿名 Key、请求三个视角；搜索、排序与分页。
- 全部请求参与成功率统计，包括零 Token 失败；输入含缓存，输出含推理，不重复相加。
- 输出 TPS、平均总耗时与平均首 Token 延迟（TTFT）；模型 / Key 聚合和请求明细均展示，支持按费用、TPS、总耗时排序。
- 预估费用卡片、Token / 费用趋势切换；模型、匿名 Key、请求明细显示费用并支持费用排序。
- 价格表弹窗可查看已调用模型的公开单价、更新价格、设置自定义价格；未定价与部分费用明确标注。
- 支持 USD / CNY 切换，默认汇率 1 USD = 7.20 CNY，可手动修改并保存在当前浏览器；费用、趋势、配额和价格表同步换算。人民币编辑单价会换算为美元保存，历史费用按当前显示汇率换算，不采用历史结算汇率。
- Codex 多账户配额面板：按账户展示 5 小时 / 每周窗口的剩余比例、重置时间、活跃期变化、费用估算及最近 30 天观察历史。

### 性能指标口径

- **TPS（Token/s）**：输出 Token ÷ 生成耗时（秒），生成耗时 = 总耗时 − TTFT。TTFT 未上报（零值或缺失）时使用总耗时；失败、无输出、缺失或无效耗时不参与。输出已包含推理，不额外相加。
- **总体 / 模型 / Key TPS**：有效请求的输出 Token 总和 ÷ 生成耗时总和，非单请求 TPS 的算术平均，也不是并发请求的系统吞吐量。
- **平均总耗时**：成功和失败请求中有效总耗时的算术平均；**平均 TTFT**：大于零且不超过总耗时的有效首 Token 延迟的算术平均。页面耗时单位为秒，API 的 `latency_ms` / `ttft_ms` 单位仍为毫秒，事件新增 `tps` 字段，无有效数据时为 `null`。
- 已有 SQLite 记录直接按保存的耗时计算，无需迁移；未保存耗时的历史请求显示“暂无”或 `—`，不作为零值参与平均。

### 费用口径

费用为 **USD 标准文本 Token 估算**，不代表订阅支出或供应商实际账单。计算公式为：

```text
费用 = (普通输入 × 输入价 + 缓存读取 × 读取价 + 缓存写入 × 写入价 + 输出 × 输出价) / 1,000,000
普通输入 = 归一化输入 - 缓存读取 - 缓存写入
```

- 单价单位为 USD / 百万 Token。推理已包含在输出中，不重复计费；失败请求按实际返回的 Token 计算，零 Token 请求费用为 0。
- 内置 [LiteLLM 公开价格快照](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)，仅匹配明确的模型名或提供方前缀，不猜测模型别名。页面使用期间每 24 小时检查更新，也可手动更新；失败保留本地价格并显示错误。只向固定价格源请求公开数据，不发送本地用量或 Key。
- 价格更新遵循运行进程的 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 环境变量；需要代理访问 GitHub 时，在启动服务或 CPA 前设置这些变量。
- 支持价格源中的长上下文阶梯；使用标准服务档位与默认缓存写入单价。现有采集没有缓存 TTL、服务档位、工具用量等信息，无法还原 1 小时缓存、Batch / Priority / Flex、图片 / 音频 / 视频 / 工具调用等额外费用。
- 自定义价格按“模型 + 提供方”保存，覆盖该组合的公开价格；恢复公开价格会创建新版本。自定义为固定单价，不保留公开阶梯。缓存单价留空表示未知，0 表示免费。
- 每次价格变动保存不可变版本，已计价请求按当时版本计算。首次接入前或当时缺价的历史请求使用首个完整可用价格，并标注“历史估算”；后续改价不会改变这些已计价历史费用。历史用量原始记录不修改。
- 任一实际使用的 Token 类别缺价，该请求显示“未定价”；总额只累计完整计价的请求，并显示覆盖数量与“部分费用”。全缺价的趋势桶保留空值。

### GPT 模型兼容

- Codex 相关统计不采用 Sol、Terra、Luna、Astra 等固定模型白名单，所有 GPT 模型及后续新增型号均可记录 Token、费用、延迟和 TPS。
- 保留原始请求模型 ID，同时保存响应中的实际模型名。价格匹配优先使用实际响应模型，原始模型作为回退；两者都未知时明确标记“未定价”，不会套用其他模型价格。
- 新模型不需要修改配额统计核心逻辑；如公开价格库尚未收录，可在价格表中为该模型设置自定义单价。

### Codex 5h / 周额度估算

此功能需要 **CPA 8.x** 在 `usage.handle` 中上报 `AuthID` / `AuthIndex` 和包含额度信息的 `ResponseHeaders`。不主动轮询账户、不读取或保存账号访问令牌，只记录本机经过 CPA 的用量与白名单额度字段。额度按响应头的实际 `window-minutes`（300 / 10080）识别，不假设 primary 永远是 5h；旧记录缺少这些信息时无法追溯补算。

- **账号剩余快照**：展示最后一次请求观察到的全账号剩余百分比、观察时间和重置时间。该值包含外部软件的使用，不是 CPA 独占余额；过期后明确提示需发起请求刷新。
- **共享配额只计一次**：当前 Codex 响应头描述的是账户级配额，Sol、Terra、Luna、Astra 或其他 GPT 模型共用同一账户配额时合并为一条账户 / 周期记录，并按模型展示 Token、费用与请求明细，不把同一份配额重复计算成多个模型的独立配额。如果服务端将来提供独立模型配额，再按模型拆分。
- **活跃期观察变化**：仅使用同匿名账号、同重置周期内连续串行请求的非负额度差值。首个请求只建立基线，间隔超过 5 秒、并发、失败、缺字段、缺价、时间乱序、额度回退或重置不产生有效扣减样本。最近 30 天的数据参与分析，不随上方日期 / 模型筛选截断。
- **本周期 CPA 估计消耗**：至少 2 个有效区间且累计额度变化大于零后，按 `样本累计百分点 / 样本 API 等价 USD` 学习账户级系数，仅外推该账号当前周期中的 CPA 请求。费用使用后端统一价格引擎计算；历史数据不完整时只覆盖已保存的请求，不是整个周期的完整账本。
- **100% / 剩余额度等价金额**：按上述系数估算整窗容量及上次观察的剩余容量，并按样本的输入 + 输出 Token 配比估算可用 Token。该金额按账户共享配额计算，不是官方额度价格、现金余额或订阅价值。
- **配额历史**：保存并展示最近 30 天的额度观察，支持 5 小时与每周窗口的剩余比例趋势、观察时间、模型和重置时间。
- **重要归因限制**：空闲时段外部软件导致的额度变化不累计；但同账号外部 Codex **在 CPA 活跃期同时使用**时，仅凭服务端账号快照无法区分，仍可能污染样本。页面始终提示这一限制，不承诺完全排除外部消耗。

## 配置

| 字段 | 说明 |
|---|---|
| `plugins.configs.usage-report.enabled` | 是否启用插件 |
| `plugins.configs.usage-report.db_path` | SQLite 路径，默认 `~/.cli-proxy-api/usage-report/usage.sqlite` |
| `plugins.store-sources` | 插件商店 registry 地址（安装/更新用） |

## 数据与安全

- 用量事件保存在 `db_path` 指向的本地 SQLite（表 `usage_events`），页面 API 在返回前将 Key 转换为稳定的匿名分组（`key-xxxxxxxxxx` 或 `未知 Key`）。
- 账号标识保存在本机，返回前转换为 `account-xxxxxxxxxx`；不向前端返回原始 AuthID / AuthIndex。上游响应头只保留额度数值和已知套餐类型，不保存 Authorization、Cookie 或任意响应头。
- 价格版本与自定义价格保存在同一 SQLite；自定义价格不包含用量或密钥。
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
cd frontend && npm ci && npm test && npm run build
cp dist/index.html ../plugin/web/index.html
cp dist/assets/* ../plugin/web/assets/
```

> 替换前端后需同步更新 `plugin/main.go` 中 embed 的文件名与 `management.register` 的资源路由（构建产物带 hash 文件名）。

### 发布新版本

版本号存于 `VERSION`，与 git tag（`v{version}`）一致。推送 tag 即触发 Release 流水线：五个平台（darwin/arm64、darwin/amd64、linux/amd64、linux/arm64、windows/amd64）构建插件并注入版本号、生成 `checksums.txt` 并发布 Release。

```sh
# 1. 更新 VERSION、CHANGELOG.md，提交并合并到 main
# 2. 打 tag 推送，流水线自动发布
git tag v0.4.3
git push origin v0.4.3
# 3. 更新插件商店 registry 中的 version 字段
```

## License

[MIT](LICENSE)。界面组件基于 [shadcn/ui](https://github.com/shadcn-ui/ui)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
