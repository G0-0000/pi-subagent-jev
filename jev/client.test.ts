import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, getAskMeta, listModels, JevError } from "./client.ts";
import { CooldownTracker, loadFailoverConfig, type FailoverConfig } from "./failover.ts";

/** 由若干 mock server 拼一条 failover 链路配置（独立 tracker，测试间互不泄漏）。 */
function chain(
  upstreams: { name: string; url: string }[],
  opts: { timeoutMs?: number; cooldownMs?: number } = {}
): { failover: FailoverConfig; tracker: CooldownTracker } {
  return {
    failover: {
      timeoutMs: opts.timeoutMs ?? 5000,
      cooldownMs: opts.cooldownMs ?? 30000,
      upstreams: upstreams.map((u) => ({
        name: u.name,
        baseUrl: u.url,
        apiKey: "sk-test-chain",
        model: `model-${u.name}`,
      })),
    },
    tracker: new CooldownTracker(),
  };
}

const OK_BODY = { model: "m", answers: { q: { noul: 0.5 } }, usage: {} };
function ok(res: http.ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(OK_BODY));
}

/** 起一个 127.0.0.1 随机端口 mock server；handler 可读取请求并响应。 */
function startServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void>; requests: () => number }> {
  let count = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        count++;
        handler(req, body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requests: () => count,
      });
    });
  });
}

/** 进程 env 缺席＋JEV_AI_ENV_FILE 指向不存在之档（每次调用唯一路径，不落缓存）→ 无 key 状态。 */
function withNoEnvKey(fn: () => Promise<void>) {
  return async () => {
    const saved = process.env.JEV_AI_API_KEY;
    const savedFile = process.env.JEV_AI_ENV_FILE;
    delete process.env.JEV_AI_API_KEY;
    process.env.JEV_AI_ENV_FILE = path.join(
      os.tmpdir(),
      `jev-nonexistent-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.JEV_AI_API_KEY = saved;
      else delete process.env.JEV_AI_API_KEY;
      if (savedFile !== undefined) process.env.JEV_AI_ENV_FILE = savedFile;
      else delete process.env.JEV_AI_ENV_FILE;
    }
  };
}

test("① noul happy path：vendor 示例结构，answers.urgent.noul 与 usage 透传", withNoEnvKey(async () => {
  // withNoEnvKey 隔离进程 env key 与 env 档（指向不存在之唯一路径），此处再隔离 model。
  const savedModel = process.env.JEV_AI_MODEL;
  delete process.env.JEV_AI_MODEL; // 隔离外部 model 配置，确保断言内建默认
  const srv = await startServer((req, body, res) => {
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "oc/jev-1.13-free");
    assert.equal(parsed.state, "My payment failed. Please help.");
    assert.ok(parsed.questions.urgent);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { urgent: { noul: 0.87 } },
        usage: { input_tokens: 296, output_tokens: 18 },
      })
    );
  });
  try {
    const r = await ask({
      state: "My payment failed. Please help.",
      questions: {
        urgent: { type: "noul", instructions: "Does this message need urgent support?" },
      },
      baseUrl: srv.url,
      apiKey: "test-key",
      proxy: "http://127.0.0.1:1", // localhost 免代理，此值不应被使用
    });
    assert.equal(r.model, "jev-1.13.0");
    assert.equal(typeof (r.answers.urgent as { noul: number }).noul, "number");
    assert.equal((r.answers.urgent as { noul: number }).noul, 0.87);
    assert.deepEqual(r.usage, { input_tokens: 296, output_tokens: 18 });
  } finally {
    await srv.close();
    if (savedModel !== undefined) process.env.JEV_AI_MODEL = savedModel;
    else delete process.env.JEV_AI_MODEL;
  }
}));

test("② 401 → unauthorized", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "bad" }),
      (e: unknown) => e instanceof JevError && e.kind === "unauthorized"
    );
  } finally {
    await srv.close();
  }
});

test("③ 402 → payment_required", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 402;
    res.end("{}");
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "k" }),
      (e: unknown) => e instanceof JevError && e.kind === "payment_required"
    );
  } finally {
    await srv.close();
  }
});

test("④ 422 → invalid_request 且带响应体摘要", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 422;
    res.end(JSON.stringify({ error: "unknown question type" }));
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "k" }),
      (e: unknown) => {
        assert.ok(e instanceof JevError && e.kind === "invalid_request");
        assert.ok((e as JevError).bodySummary?.includes("unknown question type"));
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("⑤ 429 + Retry-After:7 → rate_limited 且 retryAfterMs=7000", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 429;
    res.setHeader("Retry-After", "7");
    res.end("{}");
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "k" }),
      (e: unknown) => {
        assert.ok(e instanceof JevError && e.kind === "rate_limited");
        assert.equal((e as JevError).retryAfterMs, 7000);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("⑥ 502 → upstream；504 → upstream", async () => {
  for (const code of [502, 504]) {
    const srv = await startServer((_req, _b, res) => {
      res.statusCode = code;
      res.end("{}");
    });
    try {
      await assert.rejects(
        ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "k" }),
        (e: unknown) => e instanceof JevError && e.kind === "upstream" && (e as JevError).status === code
      );
    } finally {
      await srv.close();
    }
  }
});

test("⑦ 连不通端口 → network", async () => {
  await assert.rejects(
    ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: "http://127.0.0.1:9", apiKey: "k", timeoutMs: 3000 }),
    (e: unknown) => e instanceof JevError && e.kind === "network"
  );
});

test("⑧ 无 key（进程 env 缺席＋env 档不存在）→ not_configured", withNoEnvKey(async () => {
  await assert.rejects(
    ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: "http://127.0.0.1:9" }),
    (e: unknown) => e instanceof JevError && e.kind === "not_configured"
  );
}));

test("⑧b 显式传空 apiKey → not_configured", withNoEnvKey(async () => {
  await assert.rejects(
    ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: "http://127.0.0.1:9", apiKey: "" }),
    (e: unknown) => e instanceof JevError && e.kind === "not_configured"
  );
}));

test("⑨ choice 与 score 解析", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.end(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          route: {
            choice: {
              value: "review",
              probabilities: { pass: 0.2, review: 0.65, block: 0.15 },
              confidence: 0.72,
            },
          },
          severity: {
            score: {
              value: 2.4,
              probabilities: { "1": 0.1, "2": 0.6, "3": 0.3 },
              confidence: 0.58,
            },
          },
        },
        usage: { input_tokens: 350, output_tokens: 40 },
      })
    );
  });
  try {
    const r = await ask({
      state: "s",
      questions: {
        route: { type: "choice", instructions: "route it", options: { pass: null, review: null, block: null } },
        severity: { type: "score", instructions: "severity", levels: { "1": "low", "2": "medium", "3": "high" } },
      },
      baseUrl: srv.url,
      apiKey: "k",
    });
    const route = (r.answers.route as { choice: { value: string; probabilities: Record<string, number>; confidence: number } }).choice;
    assert.equal(route.value, "review");
    assert.equal(route.confidence, 0.72);
    assert.ok(Math.abs(Object.values(route.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    const sev = (r.answers.severity as { score: { value: number; probabilities: Record<string, number>; confidence: number } }).score;
    assert.equal(sev.value, 2.4);
    assert.equal(sev.confidence, 0.58);
  } finally {
    await srv.close();
  }
});

test("⑩ 429 时服务端仅收到 1 次请求（无自动重试）", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 429;
    res.end("{}");
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } }, baseUrl: srv.url, apiKey: "k" }),
      (e: unknown) => e instanceof JevError && e.kind === "rate_limited"
    );
    assert.equal(srv.requests(), 1);
  } finally {
    await srv.close();
  }
});

test("⑪ env 档回退：进程 env 缺席＋临时 env 档有值 → ask/listModels 以档内 key 成行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  const envPath = path.join(dir, "env");
  fs.writeFileSync(
    envPath,
    "# 注释行\n" +
      "export JEV_AI_API_KEY=\"file-key-123\"\n" +
      "OTHER_VAR=ignored\n"
  );
  const saved = process.env.JEV_AI_ENV_FILE;
  const savedKey = process.env.JEV_AI_API_KEY; // 隔离进程 env key，确保断言档内 key
  delete process.env.JEV_AI_API_KEY;
  process.env.JEV_AI_ENV_FILE = envPath;
  const srv = await startServer((req, _b, res) => {
    assert.equal(req.headers["authorization"], "Bearer file-key-123");
    if (req.method === "GET") {
      res.end(JSON.stringify({ models: ["oc/jev-1.13-free"] }));
      return;
    }
    res.end(JSON.stringify({ model: "jev-1.13-free", answers: { q: { noul: 0.5 } }, usage: {} }));
  });
  try {
    const r = await ask({
      state: "s",
      questions: { q: { type: "noul", instructions: "i" } },
      baseUrl: srv.url,
    });
    assert.equal((r.answers.q as { noul: number }).noul, 0.5);
    const m = (await listModels({ baseUrl: srv.url })) as { models: string[] };
    assert.deepEqual(m.models, ["oc/jev-1.13-free"]);
  } finally {
    await srv.close();
    if (saved !== undefined) process.env.JEV_AI_ENV_FILE = saved;
    else delete process.env.JEV_AI_ENV_FILE;
    if (savedKey !== undefined) process.env.JEV_AI_API_KEY = savedKey;
    else delete process.env.JEV_AI_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑫ env 档不存在（显式 envFile 指向不存在路径）→ not_configured", withNoEnvKey(async () => {
  await assert.rejects(
    ask({
      state: "s",
      questions: { q: { type: "noul", instructions: "i" } },
      baseUrl: "http://127.0.0.1:9",
      envFile: path.join(os.tmpdir(), `jev-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }),
    (e: unknown) => e instanceof JevError && e.kind === "not_configured"
  );
}));

test("附加：listModels GET 正常解析", async () => {
  const srv = await startServer((req, _b, res) => {
    assert.equal(req.method, "GET");
    assert.ok((req.url || "").includes("/v1/models"));
    res.end(JSON.stringify({ models: ["jev-latest", "jev-1.13.0"] }));
  });
  try {
    const r = (await listModels({ baseUrl: srv.url, apiKey: "k" })) as { models: string[] };
    assert.deepEqual(r.models, ["jev-latest", "jev-1.13.0"]);
  } finally {
    await srv.close();
  }
});

test("附加：listModels 无 key（进程 env 缺席＋env 档不存在）→ not_configured", withNoEnvKey(async () => {
  await assert.rejects(
    listModels({ baseUrl: "http://127.0.0.1:9" }),
    (e: unknown) => e instanceof JevError && e.kind === "not_configured"
  );
}));

test("⑬ 进程 env JEV_AI_MODEL 覆盖内建默认 model", async () => {
  const savedModel = process.env.JEV_AI_MODEL;
  process.env.JEV_AI_MODEL = "env-model-from-process";
  const srv = await startServer((_req, body, res) => {
    assert.equal(JSON.parse(body).model, "env-model-from-process");
    res.end(JSON.stringify({ model: "m", answers: { q: { noul: 0.5 } }, usage: {} }));
  });
  try {
    await ask({
      state: "s",
      questions: { q: { type: "noul", instructions: "i" } },
      baseUrl: srv.url,
      apiKey: "k",
    });
  } finally {
    await srv.close();
    if (savedModel !== undefined) process.env.JEV_AI_MODEL = savedModel;
    else delete process.env.JEV_AI_MODEL;
  }
});

test("⑭ env 档提供 JEV_AI_MODEL 与 JEV_AI_BASE_URL（进程 env 缺席）→ 均生效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  const envPath = path.join(dir, "env");
  const savedEnvFile = process.env.JEV_AI_ENV_FILE;
  const savedKey = process.env.JEV_AI_API_KEY; // 隔离进程 env key，确保断言档内 key
  const savedModel = process.env.JEV_AI_MODEL;
  const savedBaseUrl = process.env.JEV_AI_BASE_URL;
  delete process.env.JEV_AI_API_KEY;
  delete process.env.JEV_AI_MODEL;
  delete process.env.JEV_AI_BASE_URL;
  const srv = await startServer((req, body, res) => {
    // 请求能到达本 server 即证明 baseUrl 来自 env 档；再核 model 与 key。
    assert.equal(req.headers["authorization"], "Bearer file-key-456");
    assert.equal(JSON.parse(body).model, "file-model-789");
    res.end(JSON.stringify({ model: "m", answers: { q: { noul: 0.5 } }, usage: {} }));
  });
  fs.writeFileSync(
    envPath,
    `JEV_AI_API_KEY=file-key-456\nJEV_AI_MODEL=file-model-789\nJEV_AI_BASE_URL=${srv.url}\n`
  );
  process.env.JEV_AI_ENV_FILE = envPath;
  try {
    // 不传 baseUrl / apiKey / model，全部依赖 env 档。
    await ask({ state: "s", questions: { q: { type: "noul", instructions: "i" } } });
  } finally {
    await srv.close();
    if (savedEnvFile !== undefined) process.env.JEV_AI_ENV_FILE = savedEnvFile;
    else delete process.env.JEV_AI_ENV_FILE;
    if (savedKey !== undefined) process.env.JEV_AI_API_KEY = savedKey;
    else delete process.env.JEV_AI_API_KEY;
    if (savedModel !== undefined) process.env.JEV_AI_MODEL = savedModel;
    else delete process.env.JEV_AI_MODEL;
    if (savedBaseUrl !== undefined) process.env.JEV_AI_BASE_URL = savedBaseUrl;
    else delete process.env.JEV_AI_BASE_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑮ 显式 model 参数优先于进程 env JEV_AI_MODEL", async () => {
  const savedModel = process.env.JEV_AI_MODEL;
  process.env.JEV_AI_MODEL = "env-model-loses";
  const srv = await startServer((_req, body, res) => {
    assert.equal(JSON.parse(body).model, "explicit-model-wins");
    res.end(JSON.stringify({ model: "m", answers: { q: { noul: 0.5 } }, usage: {} }));
  });
  try {
    await ask({
      state: "s",
      questions: { q: { type: "noul", instructions: "i" } },
      model: "explicit-model-wins",
      baseUrl: srv.url,
      apiKey: "k",
    });
  } finally {
    await srv.close();
    if (savedModel !== undefined) process.env.JEV_AI_MODEL = savedModel;
    else delete process.env.JEV_AI_MODEL;
  }
});

test("⑮ baseUrl 全链路缺席 → not_configured", withNoEnvKey(async () => {
  const savedBaseUrl = process.env.JEV_AI_BASE_URL;
  delete process.env.JEV_AI_BASE_URL;
  try {
    await assert.rejects(
      () =>
        ask({
          apiKey: "test-key",
          state: "s",
          questions: { q: { type: "noul", instructions: "i" } },
        }),
      (err: unknown) => err instanceof JevError && err.kind === "not_configured"
    );
  } finally {
    if (savedBaseUrl !== undefined) process.env.JEV_AI_BASE_URL = savedBaseUrl;
  }
}));

// ── failover 链路（多 mock server；每例独立 tracker）──

const Q = { q: { type: "noul" as const, instructions: "i" } };

function assertBodyModel(body: string, model: string) {
  assert.equal(JSON.parse(body).model, model);
}

test("⑯ failover：首个 500 → 次级 200，meta.upstream=backup 且 attempts 记录败级", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 500;
    res.end("{}");
  });
  const srv2 = await startServer((_req, body, res) => {
    assertBodyModel(body, "model-backup"); // 次级用自身 model
    ok(res);
  });
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal((r.answers.q as { noul: number }).noul, 0.5);
    const meta = getAskMeta(r);
    assert.ok(meta);
    assert.equal(meta.upstream, "backup");
    assert.equal(meta.attempts.length, 1);
    assert.equal(meta.attempts[0].name, "primary");
    assert.equal(meta.attempts[0].kind, "unexpected");
    assert.equal(meta.attempts[0].status, 500);
    assert.equal(typeof meta.attempts[0].ms, "number");
    assert.equal(srv2.requests(), 1);
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("⑯b failover：首级即成 → meta.upstream=primary、attempts 空，且不可枚举不进 JSON", async () => {
  const srv1 = await startServer((_req, body, res) => {
    assertBodyModel(body, "model-explicit"); // 显式 model 覆盖仅首级
    ok(res);
  });
  const srv2 = await startServer(() => {
    throw new Error("次级不应被请求");
  });
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({
      state: "s",
      questions: Q,
      model: "model-explicit",
      failover,
      tracker,
    });
    const meta = getAskMeta(r);
    assert.ok(meta);
    assert.equal(meta.upstream, "primary");
    assert.deepEqual(meta.attempts, []);
    assert.ok(!JSON.stringify(r).includes("primary")); // symbol 不可枚举
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("⑰ failover：429+Retry-After → 切次级成功，不等待（耗时远低于 Retry-After）", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 429;
    res.setHeader("Retry-After", "60");
    res.end("{}");
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  const t0 = Date.now();
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `不睡眠：耗时 ${elapsed}ms 应远低于 Retry-After 60s`);
    assert.equal(getAskMeta(r)?.upstream, "backup");
    const a0 = getAskMeta(r)!.attempts[0];
    assert.equal(a0.kind, "rate_limited");
    assert.equal(a0.status, 429);
    assert.equal(a0.retryAfterMs, 60000); // Retry-After 仅解析入记录，绝不等待
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("⑱ failover：401 → 切次级成功", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "backup");
    assert.equal(getAskMeta(r)?.attempts[0].kind, "unauthorized");
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("⑲ failover：两级皆 502 → 抛 upstream 且 failoverAttempts 记两败级", async () => {
  const mk = () =>
    startServer((_req, _b, res) => {
      res.statusCode = 502;
      res.end("{}");
    });
  const srv1 = await mk();
  const srv2 = await mk();
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => {
        assert.ok(e instanceof JevError && e.kind === "upstream");
        assert.equal(e.status, 502);
        assert.ok(e.failoverAttempts);
        assert.equal(e.failoverAttempts!.length, 2);
        assert.deepEqual(
          e.failoverAttempts!.map((a) => a.name),
          ["primary", "backup"]
        );
        for (const a of e.failoverAttempts!) assert.equal(a.kind, "upstream");
        return true;
      }
    );
    assert.equal(srv1.requests(), 1); // 每级恰一发，同端绝不重发
    assert.equal(srv2.requests(), 1);
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("⑳ failover：首级 422 → 立即抛，次级零请求", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 422;
    res.end(JSON.stringify({ error: "bad" }));
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => e instanceof JevError && e.kind === "invalid_request"
    );
    assert.equal(srv2.requests(), 0); // 不可切换：下一级零请求
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉑ failover：首级连接拒 → network 切次级成功", async () => {
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: "http://127.0.0.1:9" },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "backup");
    assert.equal(getAskMeta(r)?.attempts[0].kind, "network");
  } finally {
    await srv2.close();
  }
});

test("㉒ failover：冷却跨两次 ask——第二次跳过已死首级", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 502;
    res.end("{}");
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r1 = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r1)?.upstream, "backup");
    const r2 = await ask({ state: "s", questions: Q, failover, tracker }); // 同一 tracker
    const m2 = getAskMeta(r2)!;
    assert.equal(m2.upstream, "backup"); // 首级冷却中被跳过
    assert.equal(m2.attempts.length, 1); // 冷却跳过亦可辨：attempts 非空
    assert.deepEqual(m2.attempts[0], { name: "primary", kind: "cooldown" });
    assert.equal(m2.attempts[0].status, undefined); // 无请求发生：无 status
    assert.equal(m2.attempts[0].ms, undefined); // 无请求发生：无 ms
    assert.equal(srv1.requests(), 1); // 死首级仅被请求一次（第二次零请求）
    assert.equal(srv2.requests(), 2);
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉓ failover：首级慢响应超 timeoutMs → timeout 切次级", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    setTimeout(() => ok(res), 1500); // --max-time 由 timeoutMs 300 收敛为 1s，先超时
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain(
    [
      { name: "primary", url: srv1.url },
      { name: "backup", url: srv2.url },
    ],
    { timeoutMs: 300 }
  );
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "backup");
    assert.equal(getAskMeta(r)?.attempts[0].kind, "timeout");
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉔ failover：显式 baseUrl/apiKey 绕开链路（校准脚本免役）", async () => {
  const srv1 = await startServer(() => {
    throw new Error("链路首级不应被请求");
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([{ name: "primary", url: srv1.url }]);
  try {
    const r = await ask({
      state: "s",
      questions: Q,
      baseUrl: srv2.url,
      apiKey: "test-key",
      failover,
      tracker,
    });
    assert.equal(getAskMeta(r), undefined); // 旧链路无 meta
    assert.equal(srv1.requests(), 0);
    assert.equal(srv2.requests(), 1);
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉕ failover：null 配置 → 旧单端点链路（429 立即抛且单发）", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 429;
    res.end("{}");
  });
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover: null, tracker: new CooldownTracker(), baseUrl: srv.url, apiKey: "test-key" }),
      (e: unknown) => e instanceof JevError && e.kind === "rate_limited"
    );
    assert.equal(srv.requests(), 1);
  } finally {
    await srv.close();
  }
});

test("㉖ failover：200 坏体（缺 answers）→ 切次级", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.end(JSON.stringify({ nope: true }));
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "backup");
    const a0 = getAskMeta(r)!.attempts[0];
    assert.equal(a0.kind, "unexpected");
    assert.equal(a0.status, undefined); // 无 HTTP status（200 坏体）
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉗ failover：首级 400 → 立即抛，次级零请求", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "bad" }));
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => e instanceof JevError && e.kind === "unexpected" && e.status === 400
    );
    assert.equal(srv2.requests(), 0); // 不可切换：下一级零请求
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉘ failover：首级 409 → 立即抛，次级零请求", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: "conflict" }));
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => e instanceof JevError && e.kind === "unexpected" && e.status === 409
    );
    assert.equal(srv2.requests(), 0); // 不可切换：下一级零请求
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉙ failover：首级 402 → 立即抛，次级零请求", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 402;
    res.end(JSON.stringify({ error: "pay" }));
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => e instanceof JevError && e.kind === "payment_required"
    );
    assert.equal(srv2.requests(), 0); // 不可切换：下一级零请求
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

test("㉚ failover：全链冷却保底真发首名（记录标 fallback），不延长次级冷却", async () => {
  // A 恒连接拒（network、可冷却）；B 先 500 后 200（可控开关）。注入时钟，全程不等真实时间。
  let bAnswerOk = false;
  const srvB = await startServer((_req, _b, res) => {
    if (bAnswerOk) {
      ok(res);
    } else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  const { failover } = chain(
    [
      { name: "A", url: "http://127.0.0.1:9" },
      { name: "B", url: srvB.url },
    ],
    { cooldownMs: 1000 }
  );
  let fakeNow = 0;
  const tracker = new CooldownTracker(() => fakeNow, 1000);
  try {
    // t=0：A network、B 500 → 两级皆入冷却（until=1000）。正常调度，记录不得带 fallback。
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => {
        assert.ok(e instanceof JevError);
        const recs = (e as JevError).failoverAttempts!;
        assert.deepEqual(recs.map((a) => a.name), ["A", "B"]);
        for (const a of recs) assert.equal(a.fallback, undefined); // 非保底：字段缺席
        return true;
      }
    );
    assert.equal(srvB.requests(), 1);

    // t=999：两级皆冷却 → 保底真发 A；A 记录带 fallback，B 为 cooldown 跳过。
    fakeNow = 999;
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => {
        assert.ok(e instanceof JevError);
        const recs = (e as JevError).failoverAttempts!;
        assert.equal(recs.length, 2);
        const a = recs[0];
        assert.equal(a.name, "A");
        assert.equal(a.kind, "network"); // 真发（cooldown 跳过者无此 kind）
        assert.equal(a.fallback, true); // 保底标记
        assert.equal(typeof a.ms, "number");
        assert.equal(a.status, undefined);
        assert.deepEqual(recs[1], { name: "B", kind: "cooldown" }); // 无 ms/status
        return true;
      }
    );
    assert.equal(srvB.requests(), 1); // 保底轮 B 零请求

    // t=1000：B 自身冷却到点即被重试（证明 A 之保底尝试未延长 B 冷却），且此胜出无 fallback。
    fakeNow = 1000;
    bAnswerOk = true;
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "B");
    const m = getAskMeta(r)!;
    assert.deepEqual(m.attempts, [{ name: "A", kind: "cooldown" }]); // A 仍冷却（其保底真发续期）
    for (const a of m.attempts) assert.equal(a.fallback, undefined);
    assert.equal(srvB.requests(), 2);
  } finally {
    await srvB.close();
  }
});

test("㉛ failover：正常切换成功之败级记录无 fallback 字段", async () => {
  const srv1 = await startServer((_req, _b, res) => {
    res.statusCode = 502;
    res.end("{}");
  });
  const srv2 = await startServer((_req, _b, res) => ok(res));
  const { failover, tracker } = chain([
    { name: "primary", url: srv1.url },
    { name: "backup", url: srv2.url },
  ]);
  try {
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    assert.equal(getAskMeta(r)?.upstream, "backup");
    const rec = getAskMeta(r)!.attempts[0];
    assert.equal(rec.fallback, undefined); // 非保底：字段缺席
    assert.ok(!("fallback" in rec));
  } finally {
    await srv1.close();
    await srv2.close();
  }
});

// ── quick-probe 单发直测（upstream 名 → 恰一发至该上游，bypass 链序/冷却/切换）──

/** 写一份临时 upstreams.json（两上游），返其路径；调用方负责清理。 */
function writeUpstreamsJson(
  entries: { name: string; url: string; apiKey: string; model: string }[]
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-upstreams-"));
  const p = path.join(dir, "upstreams.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      timeoutMs: 5000,
      cooldownMs: 30000,
      upstreams: entries.map((e) => ({
        name: e.name,
        baseUrl: e.url,
        apiKey: e.apiKey,
        model: e.model,
      })),
    })
  );
  return p;
}

test("㉝ quick-probe：upstream 给名 → 恰一发至该上游（链中他级零请求），结果带 ms", async () => {
  const srvA = await startServer((_req, _b, res) => ok(res));
  const srvB = await startServer((_req, body, res) => {
    assertBodyModel(body, "model-probe-b"); // 上游自身 model 生效
    ok(res);
  });
  const upPath = writeUpstreamsJson([
    { name: "9router-a", url: srvA.url, apiKey: "sk-secret-a", model: "model-a" },
    { name: "9router-b", url: srvB.url, apiKey: "sk-secret-b", model: "model-probe-b" },
  ]);
  try {
    const r = await ask({
      state: "s",
      questions: Q,
      upstream: "9router-b",
      upstreamsPath: upPath,
    });
    assert.equal((r.answers.q as { noul: number }).noul, 0.5);
    assert.equal(typeof r.ms, "number"); // 耗时随结果返回
    assert.ok(r.ms! >= 0);
    assert.equal(srvB.requests(), 1); // 恰一发
    assert.equal(srvA.requests(), 0); // 链中他级零请求（bypass 链序）
    assert.equal(getAskMeta(r)?.upstream, "9router-b");
  } finally {
    await srvA.close();
    await srvB.close();
    fs.rmSync(path.dirname(upPath), { recursive: true, force: true });
  }
});

test("㉞ quick-probe：未知名 → unknown_upstream，报错仅列名（绝无 baseUrl/apiKey 之值）", async () => {
  const srvA = await startServer((_req, _b, res) => ok(res));
  const upPath = writeUpstreamsJson([
    { name: "9router-a", url: srvA.url, apiKey: "sk-secret-a", model: "model-a" },
    { name: "9router-b", url: "http://127.0.0.1:9", apiKey: "sk-secret-b", model: "model-b" },
  ]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, upstream: "ghost", upstreamsPath: upPath }),
      (e: unknown) => {
        assert.ok(e instanceof JevError && e.kind === "unknown_upstream");
        assert.ok((e as JevError).message.includes("9router-a"));
        assert.ok((e as JevError).message.includes("9router-b"));
        assert.ok(!(e as JevError).message.includes("sk-secret-a")); // 绝不泄 key
        assert.ok(!(e as JevError).message.includes("sk-secret-b"));
        assert.ok(!(e as JevError).message.includes(srvA.url)); // 绝不泄 baseUrl
        return true;
      }
    );
    assert.equal(srvA.requests(), 0); // 未匹配：零请求
  } finally {
    await srvA.close();
    fs.rmSync(path.dirname(upPath), { recursive: true, force: true });
  }
});

test("㉟ quick-probe：upstreams.json 缺失 → unknown_upstream（fail-open 仅施于派单拦截，直测为量具须显报）", async () => {
  await assert.rejects(
    ask({
      state: "s",
      questions: Q,
      upstream: "any",
      upstreamsPath: path.join(
        os.tmpdir(),
        `jev-nonexistent-upstreams-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ),
    }),
    (e: unknown) => e instanceof JevError && e.kind === "unknown_upstream"
  );
});

test("㊱ quick-probe：直测不动冷却表（失败后同 tracker 链上该上游仍可正常调度）", async () => {
  const srv = await startServer((_req, _b, res) => {
    res.statusCode = 502;
    res.end("{}");
  });
  const upPath = writeUpstreamsJson([
    { name: "probe-target", url: srv.url, apiKey: "sk-secret", model: "model-x" },
  ]);
  const tracker = new CooldownTracker();
  const { failover } = chain([{ name: "probe-target", url: srv.url }]);
  try {
    await assert.rejects(
      ask({ state: "s", questions: Q, upstream: "probe-target", upstreamsPath: upPath, tracker }),
      (e: unknown) => e instanceof JevError && e.kind === "upstream"
    );
    // 直测零冷却读写：同 tracker 视该上游从未失败（eligible 仍含之）
    assert.deepEqual(tracker.eligible(["probe-target"]), ["probe-target"]);
    assert.equal(loadFailoverConfig(upPath)?.upstreams[0].name, "probe-target"); // 配置档解析无碍
  } finally {
    await srv.close();
    fs.rmSync(path.dirname(upPath), { recursive: true, force: true });
  }
});

test("㉜ failover：全链冷却保底固定取首个（到期时点不同亦取 names[0]），成败皆标 fallback", async () => {
  // A 冷却更长（until 更大）：若误取“最早到期者”会选 B；保底语义须固定取首个 A。
  let aAnswerOk = false;
  const srvA = await startServer((_req, _b, res) => {
    if (aAnswerOk) {
      ok(res);
    } else {
      res.statusCode = 502;
      res.end("{}");
    }
  });
  const srvB = await startServer((_req, _b, res) => ok(res));
  const { failover } = chain(
    [
      { name: "A", url: srvA.url },
      { name: "B", url: srvB.url },
    ],
    { cooldownMs: 1000 }
  );
  let fakeNow = 600;
  const tracker = new CooldownTracker(() => fakeNow, 1000);
  tracker.markFailure("B", true, 0); // until[B] = 1000
  tracker.markFailure("A", true, 500); // until[A] = 1500（较 B 更晚）
  try {
    // t=600：两级皆冷却 → 保底真发 A（非最早到期之 B）；A 502 则为败级记录带 fallback，B 记 cooldown。
    await assert.rejects(
      ask({ state: "s", questions: Q, failover, tracker }),
      (e: unknown) => {
        assert.ok(e instanceof JevError);
        const recs = (e as JevError).failoverAttempts!;
        assert.equal(recs.length, 2);
        assert.equal(recs[0].name, "A"); // 保底取首个
        assert.equal(recs[0].kind, "upstream");
        assert.equal(recs[0].status, 502);
        assert.equal(recs[0].fallback, true);
        assert.deepEqual(recs[1], { name: "B", kind: "cooldown" }); // 零请求
        return true;
      }
    );
    assert.equal(srvA.requests(), 1);
    assert.equal(srvB.requests(), 0); // 若误取最早到期者（B）则会请求 B

    // t=600：仍两级皆冷却，保底真发 A 而成 → 成功之保底同样可见（fallback:true）。
    // A 即链首且即成，循环未及 B，故 attempts 空（此即保底成功需另落 fallback 键之因）。
    aAnswerOk = true;
    const r = await ask({ state: "s", questions: Q, failover, tracker });
    const m = getAskMeta(r)!;
    assert.equal(m.upstream, "A");
    assert.equal(m.fallback, true);
    assert.deepEqual(m.attempts, []);
    assert.equal(srvA.requests(), 2);
    assert.equal(srvB.requests(), 0);
  } finally {
    await srvA.close();
    await srvB.close();
  }
});
