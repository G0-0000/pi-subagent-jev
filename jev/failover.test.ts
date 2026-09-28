// failover.ts 单测：loadFailoverConfig 解析校验、classifyFailure 分类表、CooldownTracker 冷却语义。
// 纯逻辑层，全走 mock（临时档 + 注入时钟），不发任何请求。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyFailure,
  CooldownTracker,
  loadFailoverConfig,
} from "./failover.ts";

function tmpConfig(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-failover-"));
  const p = path.join(dir, "upstreams.json");
  writeFileSync(p, content);
  return p;
}

const VALID = JSON.stringify({
  timeoutMs: 8000,
  cooldownMs: 15000,
  upstreams: [
    { name: "primary", baseUrl: "http://127.0.0.1:1111/", apiKey: "sk-test-a", model: "m-a" },
    { name: "backup", baseUrl: "http://127.0.0.1:2222", apiKey: "sk-test-b", model: "m-b" },
  ],
});

// ── loadFailoverConfig ──

test("① loadFailoverConfig：合法档解析，baseUrl 剥末尾斜杠，proxy 可选透传", () => {
  const p = tmpConfig(
    JSON.stringify({
      upstreams: [
        {
          name: "a",
          baseUrl: "https://a.example//",
          apiKey: "sk-test-a",
          model: "ma",
          proxy: "http://127.0.0.1:7890",
        },
        { name: "b", baseUrl: "https://b.example", apiKey: "sk-test-b", model: "mb" },
      ],
    })
  );
  const c = loadFailoverConfig(p);
  assert.ok(c);
  assert.equal(c.timeoutMs, 5000); // 缺省
  assert.equal(c.cooldownMs, 30000); // 缺省
  assert.equal(c.upstreams.length, 2);
  assert.deepEqual(c.upstreams[0], {
    name: "a",
    baseUrl: "https://a.example", // 末尾斜杠剥除
    apiKey: "sk-test-a",
    model: "ma",
    proxy: "http://127.0.0.1:7890",
  });
  assert.ok(!("proxy" in c.upstreams[1]));
});

test("② loadFailoverConfig：档不存在 → null（缺席，fail-open）", () => {
  assert.equal(loadFailoverConfig(path.join(tmpdir(), `nope-${Date.now()}.json`)), null);
});

test("③ loadFailoverConfig：坏 JSON → null", () => {
  assert.equal(loadFailoverConfig(tmpConfig("{ not json")), null);
});

test("④ loadFailoverConfig：顶层非对象/数组 → null", () => {
  assert.equal(loadFailoverConfig(tmpConfig("[]")), null);
  assert.equal(loadFailoverConfig(tmpConfig('"str"')), null);
});

test("⑤ loadFailoverConfig：upstreams 空/缺/非数组 → null", () => {
  assert.equal(loadFailoverConfig(tmpConfig(JSON.stringify({ upstreams: [] }))), null);
  assert.equal(loadFailoverConfig(tmpConfig(JSON.stringify({}))), null);
  assert.equal(loadFailoverConfig(tmpConfig(JSON.stringify({ upstreams: "x" }))), null);
});

test("⑥ loadFailoverConfig：四要素缺一/空白 → null", () => {
  const mk = (u: object) => tmpConfig(JSON.stringify({ upstreams: [u] }));
  assert.equal(loadFailoverConfig(mk({ baseUrl: "http://x", apiKey: "k", model: "m" })), null); // 缺 name
  assert.equal(loadFailoverConfig(mk({ name: " ", baseUrl: "http://x", apiKey: "k", model: "m" })), null);
  assert.equal(loadFailoverConfig(mk({ name: "a", apiKey: "k", model: "m" })), null); // 缺 baseUrl
  assert.equal(loadFailoverConfig(mk({ name: "a", baseUrl: "http://x", model: "m" })), null); // 缺 apiKey
  assert.equal(loadFailoverConfig(mk({ name: "a", baseUrl: "http://x", apiKey: "" })), null); // 空 apiKey
  assert.equal(loadFailoverConfig(mk({ name: "a", baseUrl: "http://x", apiKey: "k" })), null); // 缺 model
  assert.equal(loadFailoverConfig(mk({ name: "a", baseUrl: "http://x", apiKey: "k", model: "  " })), null);
  assert.equal(loadFailoverConfig(mk({ name: "a", baseUrl: "http://x", apiKey: "k", model: "m", proxy: 5 })), null);
});

test("⑦ loadFailoverConfig：name 重复 → null", () => {
  const p = tmpConfig(
    JSON.stringify({
      upstreams: [
        { name: "a", baseUrl: "http://x", apiKey: "k", model: "m" },
        { name: "a", baseUrl: "http://y", apiKey: "k", model: "m" },
      ],
    })
  );
  assert.equal(loadFailoverConfig(p), null);
});

test("⑧ loadFailoverConfig：timeoutMs/cooldownMs 非法 → null（须正整数），合法值生效", () => {
  const bad = (t: unknown, c: unknown) =>
    tmpConfig(
      JSON.stringify({
        ...(t !== undefined ? { timeoutMs: t } : {}),
        ...(c !== undefined ? { cooldownMs: c } : {}),
        upstreams: [{ name: "a", baseUrl: "http://x", apiKey: "k", model: "m" }],
      })
    );
  assert.equal(loadFailoverConfig(bad(0, undefined)), null);
  assert.equal(loadFailoverConfig(bad(-1, undefined)), null);
  assert.equal(loadFailoverConfig(bad(1.5, undefined)), null);
  assert.equal(loadFailoverConfig(bad("5000", undefined)), null);
  assert.equal(loadFailoverConfig(bad(undefined, 0)), null);
  assert.equal(loadFailoverConfig(bad(undefined, NaN)), null);
  const good = loadFailoverConfig(bad(1, 1));
  assert.ok(good);
  assert.equal(good.timeoutMs, 1);
  assert.equal(good.cooldownMs, 1);
});

// ── classifyFailure ──

test("⑨ classifyFailure：连接级败北 switchable+cooldownable", () => {
  for (const kind of ["network", "timeout"]) {
    assert.deepEqual(classifyFailure({ kind }), { switchable: true, cooldownable: true });
  }
  assert.deepEqual(classifyFailure({ kind: "upstream", httpStatus: 502 }), {
    switchable: true,
    cooldownable: true,
  });
  assert.deepEqual(classifyFailure({ kind: "upstream", httpStatus: 504 }), {
    switchable: true,
    cooldownable: true,
  });
  // 500/503 落 unexpected 但 status>=500 → 亦冷却
  assert.deepEqual(classifyFailure({ kind: "unexpected", httpStatus: 503 }), {
    switchable: true,
    cooldownable: true,
  });
});

test("⑩ classifyFailure：429/401 切换但绝不冷却", () => {
  assert.deepEqual(classifyFailure({ kind: "rate_limited", httpStatus: 429 }), {
    switchable: true,
    cooldownable: false,
  });
  assert.deepEqual(classifyFailure({ kind: "unauthorized", httpStatus: 401 }), {
    switchable: true,
    cooldownable: false,
  });
});

test("⑪ classifyFailure：403/404（unexpected+4xx）切换不冷却；200 坏体切换不冷却", () => {
  assert.deepEqual(classifyFailure({ kind: "unexpected", httpStatus: 403 }), {
    switchable: true,
    cooldownable: false,
  });
  assert.deepEqual(classifyFailure({ kind: "unexpected", httpStatus: 404 }), {
    switchable: true,
    cooldownable: false,
  });
  assert.deepEqual(classifyFailure({ kind: "unexpected" }), {
    switchable: true,
    cooldownable: false,
  }); // 坏 JSON / 缺 answers / NaN 状态码
});

test("⑫ classifyFailure：402/422/3xx/not_configured 不切换", () => {
  for (const f of [
    { kind: "payment_required", httpStatus: 402 },
    { kind: "invalid_request", httpStatus: 422 },
    { kind: "unexpected", httpStatus: 302 },
    { kind: "unexpected", httpStatus: 400 },
    { kind: "unexpected", httpStatus: 409 },
    { kind: "not_configured" },
  ]) {
    assert.deepEqual(classifyFailure(f), { switchable: false, cooldownable: false }, JSON.stringify(f));
  }
});

// ── CooldownTracker ──

test("⑬ CooldownTracker：markFailure 冷却期内被跳过，过期恢复，保持原序", () => {
  let now = 1000;
  const tr = new CooldownTracker(() => now, 30000);
  tr.markFailure("a", true, now);
  assert.deepEqual(tr.eligible(["a", "b", "c"], now), ["b", "c"]); // a 冷却中，原序保留
  now += 29_999;
  assert.deepEqual(tr.eligible(["a", "b", "c"], now), ["b", "c"]);
  now += 1; // 恰至过期
  assert.deepEqual(tr.eligible(["a", "b", "c"], now), ["a", "b", "c"]);
});

test("⑭ CooldownTracker：markSuccess 立即清除冷却", () => {
  let now = 0;
  const tr = new CooldownTracker(() => now, 30000);
  tr.markFailure("a", true, now);
  assert.deepEqual(tr.eligible(["a", "b"], now), ["b"]); // a 冷却中
  tr.markSuccess("a");
  assert.deepEqual(tr.eligible(["a", "b"], now), ["a", "b"]); // 立即恢复
});

test("⑮ CooldownTracker：非冷却败北（429/4xx）不记", () => {
  const now = 0;
  const tr = new CooldownTracker(() => now, 30000);
  tr.markFailure("a", false, now);
  assert.deepEqual(tr.eligible(["a"], now), ["a"]);
});

test("⑯ CooldownTracker：全在冷却 → 保底返回首个（绝不空链）", () => {
  const now = 0;
  const tr = new CooldownTracker(() => now, 30000);
  tr.markFailure("a", true, now);
  tr.markFailure("b", true, now);
  assert.deepEqual(tr.eligible(["a", "b"], now), ["a"]);
});

test("⑰ CooldownTracker：缺省时钟 Date.now、缺省冷却 30s；不传 nowMs 时读时钟", () => {
  const tr = new CooldownTracker();
  tr.markFailure("a", true);
  assert.deepEqual(tr.eligible(["a", "b"]), ["b"]); // 30s 内冷却中
  tr.markSuccess("a");
  assert.deepEqual(tr.eligible(["a", "b"]), ["a", "b"]);
});

test("⑱ CooldownTracker：未标记之名不受影响；eligible 空输入返空", () => {
  const now = 0;
  const tr = new CooldownTracker(() => now, 30000);
  tr.markFailure("x", true, now);
  assert.deepEqual(tr.eligible(["a", "b"], now), ["a", "b"]);
  assert.deepEqual(tr.eligible([], now), []);
});

test("⑲ CooldownTracker：注入 cooldownMs=1000 —— 500ms 冷却中，1500ms 恰到期恢复", () => {
  const tr = new CooldownTracker(() => 0, 1000);
  tr.markFailure("a", true, 500);
  assert.deepEqual(tr.eligible(["a", "b"], 500), ["b"]); // 冷却窗内
  assert.deepEqual(tr.eligible(["a", "b"], 1499), ["b"]); // 1500 前仍冷却
  assert.deepEqual(tr.eligible(["a", "b"], 1500), ["a", "b"]); // 恰到期恢复
});

test("⑳ eligibleDetailed：三态（无冷却/部分/全冷却保底）＋空输入，显式 nowMs 胜过注入时钟", () => {
  const tr = new CooldownTracker(() => 999_999, 30000); // 注入时钟恒指 999999
  // (a) 无冷却（走缺省时钟）→ 原序全量、fellBack false
  assert.deepEqual(tr.eligibleDetailed(["a", "b"]), { names: ["a", "b"], fellBack: false });
  // (b) 部分冷却：a 于 t=0 冷却（until=30000）→ 显式 nowMs=0 下 a 仍冷，返其余、fellBack false
  tr.markFailure("a", true, 0);
  assert.deepEqual(tr.eligibleDetailed(["a", "b", "c"], 0), {
    names: ["b", "c"],
    fellBack: false,
  });
  // 显式 nowMs 胜过注入时钟：若改用注入时钟 999999，则 a 早已过期而全量返回
  assert.deepEqual(tr.eligibleDetailed(["a", "b", "c"]), {
    names: ["a", "b", "c"],
    fellBack: false,
  });
  // (c) 全冷却 → 保底返回原序首个、fellBack true
  tr.markFailure("b", true, 0);
  tr.markFailure("c", true, 0);
  assert.deepEqual(tr.eligibleDetailed(["a", "b", "c"], 0), { names: ["a"], fellBack: true });
  // (d) 空输入 → 空、fellBack false（绝不保底出首名）
  assert.deepEqual(tr.eligibleDetailed([], 0), { names: [], fellBack: false });
});

test("㉑ CooldownTracker：续期不缩短 —— 显式 nowMs 回拨不改早已置定之较晚 until", () => {
  const tr = new CooldownTracker(() => 0, 1000);
  tr.markFailure("a", true, 5000); // until = 6000
  tr.markFailure("a", true, 0); // 早于既有：不回归 1000
  assert.deepEqual(tr.eligible(["a", "b"], 5999), ["b"]); // 仍冷却至 6000
  assert.deepEqual(tr.eligible(["a", "b"], 6000), ["a", "b"]); // 恰到期恢复
});

test("㉒ CooldownTracker：负时钟下未标记之名视为可选（哨兵 -Infinity，不误判冷却）", () => {
  const tr = new CooldownTracker(() => -5000, 1000);
  // 未标记：-Infinity 哨兵恒 ≤ 负时刻 → 可选，且不因全判冷却而走保底
  assert.deepEqual(tr.eligibleDetailed(["a", "b"], -5000), { names: ["a", "b"], fellBack: false });
  tr.markFailure("a", true, -5000); // until = -4000
  assert.deepEqual(tr.eligibleDetailed(["a", "b"], -5000), { names: ["b"], fellBack: false });
});
