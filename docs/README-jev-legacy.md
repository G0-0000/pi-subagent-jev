# jev-client

JEV System One 决策模型客户端（9router 本地端点）。零 npm 依赖，curl 传输，供 pi 扩展调用。

## 用途

对一份 `state` 并行求值一组类型化问题（noul / choice / score），返回可直接分支的 typed 答案。

- `ask({state, questions, model?, baseUrl?, apiKey?, proxy?, timeoutMs?})` → `{model, answers, usage}`
- `listModels({...})` → 端点所给已连接模型列表

## 端点与模型

- 默认端点：`http://192.168.3.119:8081`（9router，LAN 直连，**免代理**）
- 路径：`POST /v1/systemone`、`GET /v1/models`
- 默认模型：`oc/jev-1.13-free`（注：该 id 不在 `/v1/models` 返回列表中，但 `/v1/systemone` 实测有效，列表不全）

## 配置

`~/.config/jev/env`（600）：

```
export JEV_AI_API_KEY=sk-...   # 9router key，勿回显
```

`~/.bashrc` 末尾已加：

```
[ -f ~/.config/jev/env ] && . ~/.config/jev/env
```

环境变量：`JEV_AI_API_KEY`（9router 需认证；三处均未得 key 即报 not_configured，见下节）、`JEV_AI_BASE_URL`（默认如上）、`JEV_AI_PROXY`（默认**不用代理**；显式给值方用，localhost URL 仍免代理）。

## key 解析序

显式参数 `apiKey` > 环境变量 `JEV_AI_API_KEY` > env 档（路径：显式参数 `envFile` > `JEV_AI_ENV_FILE` > 默认 `~/.config/jev/env`；识 `export KEY=VALUE` 与 `KEY=VALUE`，去引号，进程内缓存）。全部落空 → `JevError` kind `not_configured`；key 之值绝不出现在任何错误消息、日志或返回文本。

## 测试

```
cd ~/.pi/agent/jev && node --test *.test.ts
```

## pi 工具（~/.pi/agent/extensions/jev.ts）

- `jev_ask{state, questions, model?}` — 对 state 求值 questions，返回 JSON 结果；错误返回可读 JevError kind/message（不含 key）
- `jev_models{}` — 返回已连接模型列表

错误 kind：not_configured / unauthorized / payment_required / invalid_request / rate_limited（附 retryAfterMs）/ upstream / timeout / network / unexpected。**任何情形不自动重试**。
