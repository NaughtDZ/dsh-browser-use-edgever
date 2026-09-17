import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { normalizeUsage, estimateCost, readJson } from "../scripts/eval/core.mjs"
import { parsePricing, summarizeCalls, recoverCalls, taskMetrics, taskTable, aggregateMetrics, outputCacheTokens } from "../scripts/eval/metrics.mjs"
import { normalizeResponses } from "../scripts/eval/responses.mjs"
import { loadConfig } from "../scripts/eval/config.mjs"
import { judgeResult } from "../scripts/eval/judge.mjs"

const usage = (input, cache_read, output, cache_write = 0) => ({ input, cache_read, cache_write, output, reasoning: 0 })
const call = tokens => ({ usage: tokens, cost: estimateCost(tokens, "MiniMax-M3"), duration_ms: 10 })

test("output caching is recorded only when explicitly reported and survives Responses normalization", () => {
  const normalized = normalizeResponses({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "fixture" }] }], usage: { input_tokens: 20, output_tokens: 10, output_tokens_details: { cached_tokens: 4 } } })
  assert.equal(outputCacheTokens(normalized.usage), 4)
  assert.equal(outputCacheTokens({ completion_tokens: 10 }), null)
  assert.equal(outputCacheTokens({ completion_tokens: 10, completion_tokens_details: { cached_tokens: 11 } }), null)
})

test("task table matches the requested example and weights the total cache hit rate", () => {
  const rows = [
    ["Allrecipes--0", 196457, 18, 17, usage(122776, 153236, 10041)],
    ["Allrecipes--1", 131696, 24, 25, usage(141596, 325576, 6384)],
    ["Allrecipes--2", 101637, 19, 18, usage(83477, 208543, 4635)],
  ].map(([task_id, duration_ms, steps, model_rounds, tokens]) => ({ task_id, duration_ms, steps, model_rounds, ...summarizeCalls([call(tokens)]) }))
  const { markdown, csv } = taskTable(rows)
  assert.match(markdown, /196\.457 秒 \| 18 \| 17 \| 122,776 \| 153,236 \| 0 \| 10,041 \| 55\.52% \| \$0\.05807616/)
  assert.match(markdown, /\*\*429\.790 秒\*\*/)
  assert.match(markdown, /\*\*66\.40%\*\* \| \*\*\$0\.17086800\*\*/)
  assert.match(csv, /"Allrecipes--0","196\.457","18","17"/)
  assert.equal(csv.charCodeAt(0), 0xfeff)
})

test("partial usage remains a lower bound and no requests are known zero", () => {
  const result = summarizeCalls([call(usage(20, 80, 10, 5)), { usage: null, cost: null, duration_ms: 20 }])
  assert.equal(result.tokens, null)
  assert.equal(result.tokens_observed.input, 20)
  assert.equal(result.usage_observed.cache_miss_tokens, 25)
  assert.equal(result.usage_observed.input_tokens, 105)
  assert.equal(result.usage_observed.cache_hit_rate, 80 / 105)
  assert.equal(result.usage_metrics.cache_hit_rate, null)
  assert.equal(result.usage_metrics.output_cache_tokens, null)
  assert.equal(result.cost, null)
  assert.equal(result.usage_missing_calls, 1)
  assert.equal(summarizeCalls([]).cost, 0)
  assert.equal(summarizeCalls([]).tokens.input, 0)
})

test("custom pricing handles cache creation without double charging reasoning", () => {
  const pricing = parsePricing('{"input":2,"output":8,"cache_read":0.5,"cache_write":3}')
  const tokens = { ...usage(10, 20, 40, 30), reasoning: 35 }
  assert.ok(Math.abs(estimateCost(tokens, "custom", pricing) - 0.00044) < 1e-12)
  assert.equal(estimateCost(tokens, "custom"), null)
  assert.equal(estimateCost(tokens, "custom", { input: 2, output: 8 }), null)
  for (const value of ['{"input":-1,"output":1}', '{"input":"2","output":1}', '{"input":1,"output":1,"context_threshold":5}', '{"input":1,"output":1,"typo":3}']) assert.throws(() => parsePricing(value))
})

test("pricing configuration is fingerprintable and never inherited by a different judge model", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-prices-"))
  try {
    const env = { DSH_HOME: directory, EVAL_API_KEY: "fixture", EVAL_PRICING_JSON: '{"input":2,"output":8}' }
    const shared = loadConfig(env)
    assert.deepEqual(shared.agent.pricing, shared.judge.pricing)
    assert.equal(loadConfig({ ...env, EVAL_JUDGE_MODEL: "different" }).judge.pricing, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("worker trace recovery retains paid responses and unknown in-flight requests", () => {
  const calls = recoverCalls([
    { type: "model/request", call_index: 1, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "model/response", call_index: 1, ...call(usage(10, 5, 2)), response: { content: "private" } },
    { type: "model/request", call_index: 2 },
  ])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].response, undefined)
  assert.equal(calls[1].status, "incomplete")
  const summary = summarizeCalls(calls)
  assert.equal(summary.cost, null)
  assert.equal(summary.cost_observed, calls[0].cost)
  assert.equal(summary.usage_missing_calls, 1)
})

test("judge transport failure after a paid repair attempt does not claim complete usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-judge-metrics-"))
  try {
    writeFileSync(join(directory, "session.json"), JSON.stringify([{ type: "tool/result", seq: 1, data: { message: { content: [{ type: "text", text: "Evidence" }] } } }]))
    let requests = 0
    const judged = await judgeResult({ task_id: "x", status: "completed", final_answer: "x", task: "x", website: "https://example.com", tool_trace: [] }, { model: "MiniMax-M3" }, "evidence", directory, async () => {
      if (++requests === 2) throw new Error("fetch failed")
      return { usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ finish_reason: "stop", message: { content: "{}" } }] }
    })
    assert.equal(judged.tokens, null)
    assert.equal(judged.tokens_observed.input, 100)
    assert.equal(judged.cost, null)
    assert.ok(judged.cost_observed > 0)
    assert.equal(judged.usage_missing_calls, 1)
    assert.equal(judged.requests, 2)
    assert.ok(Date.parse(judged.finished_at) >= Date.parse(judged.started_at))
    assert.ok(judged.duration_ms >= 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("task costs separate agent and judge; skipped judging is zero, unknown judging is not", () => {
  assert.equal(taskMetrics({ cost: 0.2, judge_result: { cost: 0.1 } }).total_cost_usd, 0.2 + 0.1)
  assert.equal(taskMetrics({ cost: 0.2, judge_mode: "none" }).total_cost_usd, 0.2)
  assert.equal(taskMetrics({ cost: 0.2 }).total_cost_usd, null)
  assert.equal(aggregateMetrics([{ cost: null, tokens: null }]).total_task_cost_usd, null)
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 20 }).input, 20)
})

test("CLI persists the ledger after each task, before dispatching the next one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-ledger-"))
  const output = join(directory, "run")
  let requests = 0, intermediate
  const server = createServer((request, response) => {
    request.resume()
    requests++
    if (requests === 3) intermediate = readFileSync(join(output, "task-metrics.md"), "utf8")
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fixture answer" } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 10 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--count", "2", "--out", output, "--judge", "none"], {
      env: { ...process.env, DSH_HOME: directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_JUDGE_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: `http://127.0.0.1:${server.address().port}`, EVAL_API_KEY: "fixture", EVAL_PRICING_JSON: '{"input":2,"output":8,"cache_read":0.5}' },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })
    let logs = ""
    child.stdout.on("data", data => { logs += data })
    child.stderr.on("data", data => { logs += data })
    const [code] = await once(child, "close")
    assert.equal(code, 0, logs)
    assert.equal(requests, 3)
    assert.match(intermediate, /Allrecipes--0/)
    assert.doesNotMatch(intermediate, /Allrecipes--1/)
    const rows = readJson(join(output, "task-metrics.json"))
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.status, "completed")
      assert.equal(row.cache_hit_tokens, 60)
      assert.equal(row.cache_miss_tokens, 40)
      assert.equal(row.model_requests, 1)
      assert.ok(row.model_steps > 0)
      assert.equal(row.total_cost_usd, 0.00019)
      assert.ok(Date.parse(row.finished_at) >= Date.parse(row.started_at))
      assert.ok(row.duration_ms >= 0)
    }
    assert.match(readFileSync(join(output, "task-metrics.csv"), "utf8"), /合计/)
    assert.equal(readJson(join(output, "summary.json")).usage_metrics.cache_hit_rate, 0.6)
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }) }
})
