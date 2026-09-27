import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, getAskMeta, listModels, JevError } from "./client.ts";
import { CooldownTracker, type FailoverConfig } from "./failover.ts";

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
