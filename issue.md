# huidian_entry 路由结束前因远程模型价格表查询阻塞约 60 秒

-   排查日期：2026-09-16
-   状态：已定位，尚未修复
-   涉及组件：Flowise Agentflow Agent、模型价格表加载器、huidian_agent 入口路由
-   排查方式：只读代码与运行配置检查、真实 SSE 请求计时、容器内独立进程函数探针；未修改服务配置、业务代码或画布。

## 问题现象与影响

通过 `huidian_entry` 请求时，入口第一轮思考结束后，长时间没有子 flow 的流式输出。

实测主要等待发生在入口已经输出完整路由 JSON、但尚未发出 `end` 的阶段。Python 按约定等待入口正常结束才启动子 flow，因此入口收尾延迟直接阻塞子 flow 启动。子 flow 自己完成正文后也出现同类收尾等待。

预期行为：模型完成路由或回答后，价格元数据查询不应额外阻塞流程结束约一分钟。

## 环境与探针方法

-   完整链路：宿主 `8002` 服务的 `/v1/chat/completions`，模型为 `huidian_entry`，开启 `X-Huidian-Debug-Flowise: true`。
-   Flowise：宿主 `3001` 端口对应 `flowise-local` 容器。
-   SSE 探针使用 `time.monotonic()` 记录客户端收到事件的相对时间，逐行消费响应，不缓存完整响应后计时。
-   只输出事件类型、阶段、时间及必要摘要，不保存凭据或完整工具结果。
-   线上入口和被检查的两个子 flow 的模型均配置 `streaming=true`。
-   容器未设置 `MODEL_LIST_CONFIG_JSON`，实际使用默认远程价格表地址。

以下时间均相对各自请求开始，客户端接收时间包含传输和适配开销。

## 探针一：完整 huidian_entry 请求

输入：`兰亭序是谁写的？`，无历史消息；入口选择 `flowise-qa`。

| 事件                       |   相对时间 |
| -------------------------- | ---------: |
| HTTP 响应头                |   0.104 秒 |
| 入口首事件                 |   0.351 秒 |
| 入口首次 thinking          |   1.034 秒 |
| 入口最后一次 thinking      |   1.295 秒 |
| 入口首个路由 token         |   1.296 秒 |
| 入口最后一个路由 token     |   1.313 秒 |
| 入口 calledTools（空数组） |  61.972 秒 |
| 入口 usageMetadata         |  61.973 秒 |
| 入口 end / Python 路由决策 |  61.984 秒 |
| 子 flow 首事件             |  62.282 秒 |
| 子 flow 首次 thinking      |  63.043 秒 |
| 子 flow 首次工具调用事件   |  63.534 秒 |
| 子 flow 首个正文 token     |  71.848 秒 |
| 子 flow 最后一个正文 token |  73.891 秒 |
| 子 flow usedTools          |  73.893 秒 |
| 子 flow usageMetadata      | 134.034 秒 |
| 子 flow end                | 134.048 秒 |
| 对外 `[DONE]`              | 134.049 秒 |

分段结果：

-   入口路由 JSON 输出完至入口 `end`：**60.671 秒**。
-   入口 `end` 至子 flow 首事件：**0.298 秒**。
-   入口 `end` 至子 flow 首次思考：**1.059 秒**。
-   子 flow 正文输出完至其 `end`：**60.157 秒**。

这条请求的主要空白期在入口收尾，未落在子 flow 启动或首次思考阶段；回答输出结束后还存在第二次同类收尾等待。

## 探针二：绕过 Python，直接请求入口 Flowise

通过入口 Prediction API 发起流式请求，输入 `你好`，无历史消息。

| 事件                        |  相对时间 |
| --------------------------- | --------: |
| 入口首事件                  |  0.288 秒 |
| 首个路由 token              |  1.069 秒 |
| 最后一个路由 token          |  1.109 秒 |
| calledTools / usageMetadata | 61.250 秒 |
| end                         | 61.262 秒 |

最终路由为 `{"route":"flowise-qa"}`，路由内容完成至 `end` 相隔 **60.153 秒**。

节点输出中的 `timeMetadata.delta` 为 **802 毫秒**。这项内部计时与客户端观察到的约 61 秒流程结束时间明显不同，因此不能仅凭节点内部计时判断不存在收尾延迟。

绕过 Python 后仍然复现，说明该约 60 秒等待位于 Flowise 内部。

## 探针三：实际容器内的模型价格查询函数

在 `flowise-local` 容器中启动独立 Node 进程，加载实际部署的：

```text
/usr/src/flowise/packages/components/dist/src/modelLoader.js
```

调用 `getModelConfigByModelName('chat', 'chatOpenAICustom', 'probe-no-model')`，通过该独立进程内的 Axios 拦截器记录网络请求时间和结果。此探针不调用模型推理；模型名仅作为查询占位符，价格表加载发生在模型匹配之前。

| 检查项                   | 结果                         |
| ------------------------ | ---------------------------- |
| 默认价格表请求目标       | `raw.githubusercontent.com`  |
| 远程请求结束时间         | 60,244 毫秒                  |
| 远程请求结果             | `ECONNRESET`，无 HTTP 状态码 |
| 包含本地回退的完整查询   | 60,249 毫秒                  |
| 同函数直接读取本地价格表 | 1 毫秒                       |

对照检查仅在该探针进程内临时设置：

```text
MODEL_LIST_CONFIG_JSON=/usr/src/flowise/packages/components/models.json
```

未修改运行中 Flowise 服务的环境变量、文件或配置。该结果证明远程价格表查询本身足以产生与 SSE 空白期吻合的约 60 秒等待；本地读取不具有该延迟。

## 根因与代码证据

已核对本地 Flowise 源码与容器内相关编译代码的调用顺序。

1. Agent 在生成完成后的收尾阶段同步等待 `calculateUsageCost()`。
    - 源码：`../Flowise/packages/components/nodes/agentflow/Agent/Agent.ts:1449`。
    - 容器编译代码：`/usr/src/flowise/packages/components/dist/nodes/agentflow/Agent/Agent.js:1271`。
2. `calculateUsageCost()` 调用 `getModelConfigByModelName()` 查询模型价格。
    - 源码：`../Flowise/packages/components/nodes/agentflow/Agent/Agent.ts:1996`。
3. 模型价格加载器每次调用均加载价格表。默认同步请求：
   `https://raw.githubusercontent.com/FlowiseAI/Flowise/main/packages/components/models.json`。
    - 源码：`../Flowise/packages/components/src/modelLoader.ts:36`。
    - 网络请求为 `await axios.get(modelFile)`，该调用未设置显式超时，也没有加载结果缓存。
    - 网络请求失败后，才读取随部署提供的本地 `models.json`。
4. 价格查询完成后，Agent 才继续生成输出元数据及执行后续收尾，流程随后发出最终 `end`。
5. Python 入口路由必须收到正常 `end` 才校验并交出路由决策。
    - [flowise_router.py](huidian_agent/api/flowise_router.py)，`FlowiseRouter.astream()`。
    - [routed_flowise_app.py](huidian_agent/api/routed_flowise_app.py)，`RoutedFlowiseApp.astream()`。

因果链路：

```text
入口已输出路由 JSON
  → 同步计算费用
  → 下载 GitHub 模型价格表
  → 约 60 秒后 ECONNRESET
  → 回退读取本地价格表
  → Flowise 继续收尾并发出 end
  → Python 启动子 flow
```

设计层根因是：**非回答必需的价格元数据依赖，被放到了 Agent 完成及跨流程交接的同步关键路径上，而且每次执行都承担外部网络失败的等待成本。**

`ECONNRESET` 的具体网络来源尚未定位，不能据此认定是 GitHub、代理或防火墙中的某一方主动断开；约 60 秒也不是在上述函数中配置的固定超时时间。这不影响对当前耗时函数和关键路径问题的定位。

## 修复建议（未执行）

### 部署配置方案

将 Flowise 服务的 `MODEL_LIST_CONFIG_JSON` 配置为容器中已存在的本地文件：

```text
/usr/src/flowise/packages/components/models.json
```

这利用加载器已有能力，消除请求收尾对外部价格表下载的依赖。需要确认文件路径在后续镜像中稳定存在，并随部署维护价格表版本；本地文件可能不包含最新模型价格。

### 代码层修复方向

-   将价格表加载、缓存与刷新统一由模型元数据加载器负责，避免每个 Agent 重复下载。
-   使用本地或最近有效缓存满足请求路径的读取，远程更新在后台执行。
-   为远程刷新设置有限超时及失败回退，避免价格元数据不可用阻塞回答完成。
-   明确计时边界，使生成耗时、价格查询耗时及整个流程耗时可区分。

不建议通过 Python 在收到部分路由内容后提前启动子 flow 来绕开等待。这会弱化正常结束后才能确认路由的契约，而且无法解决子 flow 正文输出完仍多等约 60 秒的问题。

## 修复后验证标准

1. 使用同样问题和 SSE 计时方式复测，入口路由 JSON 输出完至 `end` 不再出现约 60 秒固定量级的空白期。
2. 子 flow 正文输出完至 `end` 同样不再出现该空白期。
3. 远程价格表不可达时，缓存或本地文件可用，路由、回答及终止事件仍正常完成。
4. 重复请求不会逐次同步下载远程价格表；需要刷新时应验证后台刷新和超时行为。
5. 保持路由校验、入口失败不启动子 flow、子 flow SSE 逐条转发的现有行为。

## 验证范围与限制

本次完成一次完整入口到问答子 flow 的请求、一次直接入口请求，以及一次远程/本地价格表函数对照。没有执行修复、重启服务或运行回归测试；没有对深度研究分支做完整端到端计时。共享代码表明其存在同类风险，但具体时长仍需该分支实测。
