// Amounts are USD list-price estimates, never provider invoices.
export const DEFAULT_PRICING = {
  input: 0.30, output: 1.20, cache_read: 0.06,
  context_threshold: 512000, long_context_multiplier: 2,
  source: "https://platform.minimax.io/docs/guides/pricing-paygo", date: "2026-09-13",
}
const tokenKeys = ["input", "output", "cache_read", "cache_write", "reasoning"]
const sum = values => values.reduce((a, b) => a + b, 0)
const knownSum = values => values.length && values.every(Number.isFinite) ? sum(values) : null
const emptyTokens = () => Object.fromEntries(tokenKeys.map(key => [key, 0]))

export function parsePricing(value, name = "pricing") {
  if (!value) return undefined
  let pricing
  try { pricing = JSON.parse(value) } catch { throw new Error(`${name} must be a JSON object`) }
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) throw new Error(`${name} must be a JSON object`)
  const allowed = ["input", "output", "cache_read", "cache_write", "context_threshold", "long_context_multiplier", "source", "date"]
  if (Object.keys(pricing).some(key => !allowed.includes(key))) throw new Error(`${name} contains an unknown pricing field`)
  for (const key of ["input", "output", "cache_read", "cache_write"]) {
    if ((key === "input" || key === "output" || key in pricing) && (!Number.isFinite(pricing[key]) || pricing[key] < 0)) throw new Error(`${name}.${key} must be a nonnegative USD price per million tokens`)
  }
  if (("context_threshold" in pricing) !== ("long_context_multiplier" in pricing)) throw new Error(`${name} requires both context_threshold and long_context_multiplier`)
  for (const key of ["context_threshold", "long_context_multiplier"]) {
    if (key in pricing && (!Number.isFinite(pricing[key]) || pricing[key] <= 0)) throw new Error(`${name}.${key} must be positive`)
  }
  for (const key of ["source", "date"]) if (key in pricing && typeof pricing[key] !== "string") throw new Error(`${name}.${key} must be a string`)
  return pricing
}

export function priceUsage(usage, model, customPricing) {
  const pricing = customPricing ?? (model === "MiniMax-M3" ? DEFAULT_PRICING : null)
  if (!usage || !pricing) return null
  if (tokenKeys.some(key => !Number.isFinite(usage[key]) || usage[key] < 0)) return null
  const inputTotal = usage.input + usage.cache_read + usage.cache_write
  const multiplier = inputTotal > (pricing.context_threshold ?? Infinity) ? pricing.long_context_multiplier : 1
  const parts = Object.fromEntries(["input", "output", "cache_read", "cache_write"].map(key => [key, usage[key] === 0 ? 0 : Number.isFinite(pricing[key]) ? usage[key] * pricing[key] * multiplier / 1e6 : null]))
  return { currency: "USD", ...parts, total: knownSum(Object.values(parts)), multiplier, pricing }
}

export function tokenMetrics(tokens, outputCached = null) {
  const total = tokens ? tokens.input + tokens.cache_read + tokens.cache_write : null
  return {
    input_tokens: total, output_tokens: tokens?.output ?? null,
    uncached_input_tokens: tokens?.input ?? null,
    cache_hit_tokens: tokens?.cache_read ?? null,
    cache_miss_tokens: tokens ? tokens.input + tokens.cache_write : null,
    cache_write_tokens: tokens?.cache_write ?? null,
    output_cache_tokens: outputCached,
    reasoning_tokens: tokens?.reasoning ?? null,
    total_tokens: tokens ? total + tokens.output : null,
    cache_hit_rate: total > 0 ? tokens.cache_read / total : null,
  }
}

export function outputCacheTokens(usage) {
  const value = usage?.completion_tokens_details?.cached_tokens
  return Number.isFinite(value) && value >= 0 && value <= usage.completion_tokens ? value : null
}

export function summarizeCalls(calls) {
  const observed = emptyTokens()
  for (const call of calls) if (call.usage) for (const key of tokenKeys) observed[key] += call.usage[key]
  const missing = calls.filter(call => !call.usage).length
  const unpriced = calls.filter(call => !Number.isFinite(call.cost)).length
  const outputCached = calls.length ? knownSum(calls.map(call => call.output_cache_tokens)) : 0
  return {
    request_count: calls.length,
    usage_missing_calls: missing, unpriced_calls: unpriced,
    tokens: missing ? null : observed, tokens_observed: observed,
    usage_metrics: tokenMetrics(missing ? null : observed, outputCached),
    usage_observed: tokenMetrics(observed, outputCached),
    cost: unpriced ? null : sum(calls.map(call => call.cost)),
    cost_observed: sum(calls.map(call => call.cost ?? 0)),
    model_duration_ms: sum(calls.map(call => call.duration_ms ?? 0)),
  }
}

/** Recover completed requests and retain unknown usage for requests interrupted in flight. */
export function recoverCalls(trace) {
  const calls = []
  for (const event of trace) {
    if (event.type === "model/request") calls.push({ call_index: event.call_index ?? calls.length + 1, started_at: event.started_at ?? event.timestamp, usage: null, cost: null, duration_ms: null, status: "incomplete" })
    if (event.type === "model/response" || event.type === "model/error") {
      const call = event.call_index ? calls.find(c => c.call_index === event.call_index) : calls.findLast(c => c.status === "incomplete")
      if (call) {
        const { type, response, error, timestamp, ...metrics } = event
        Object.assign(call, metrics, { finished_at: event.finished_at ?? timestamp, status: type === "model/error" ? "error" : "success" })
      }
    }
  }
  return calls
}

export function taskMetrics(result) {
  const judge = result.judge_result
  const judgedCost = judge ? judge.cost ?? null : result.judge_mode === "none" ? 0 : null
  const agentUsage = result.usage_metrics ?? tokenMetrics(result.tokens)
  return {
    metrics_version: 1,
    ...agentUsage,
    agent_cost_usd: result.cost ?? null,
    judge_cost_usd: judgedCost,
    total_cost_usd: knownSum([result.cost, judgedCost]),
    observed_cost_usd: (result.cost_observed ?? result.cost ?? 0) + (judge?.cost_observed ?? judge?.cost ?? 0),
    agent_duration_ms: result.duration_ms ?? null,
    judge_duration_ms: judge?.duration_ms ?? (result.judge_mode === "none" ? 0 : null),
    // This is active work time; it excludes dispatch, screenshots, cleanup and idle resume gaps.
    active_duration_ms: knownSum([result.duration_ms, judge?.duration_ms ?? (result.judge_mode === "none" ? 0 : null)]),
  }
}

export function aggregateMetrics(results) {
  const rows = results.map(taskMetrics)
  const usages = results.map(result => result.tokens)
  const tokens = usages.every(Boolean) && usages.length ? Object.fromEntries(tokenKeys.map(key => [key, sum(usages.map(usage => usage[key]))])) : null
  const observed = Object.fromEntries(tokenKeys.map(key => [key, sum(results.map(result => (result.tokens_observed ?? result.tokens)?.[key] ?? 0))]))
  return {
    tokens, tokens_observed: observed, usage_metrics: tokenMetrics(tokens, knownSum(rows.map(row => row.output_cache_tokens))),
    usage_observed: tokenMetrics(observed),
    total_task_cost_usd: knownSum(rows.map(row => row.total_cost_usd)),
    observed_task_cost_usd: sum(rows.map(row => row.observed_cost_usd)),
    total_model_requests: knownSum(results.map(result => result.request_count ?? result.model_rounds)),
    total_model_steps: knownSum(results.map(result => result.model_steps)),
    total_retries: knownSum(results.map(result => result.retry_count)),
    usage_missing_calls: knownSum(results.map(result => result.usage_missing_calls)),
  }
}

export function taskRows(results, tasks) {
  const byId = new Map(results.map(result => [result.task_id, result]))
  return tasks.map(task => {
    const result = byId.get(task.task_id) ?? { status: "missing" }
    const metrics = taskMetrics(result)
    return {
      task_id: task.task_id, status: result.status, pass: result.judge_result?.pass ?? null,
      attempt: result.attempt_number ?? (byId.has(task.task_id) ? 1 : null),
      started_at: result.started_at ?? null, finished_at: result.finished_at ?? null,
      evaluation_finished_at: result.evaluation_finished_at ?? null,
      duration_ms: result.duration_ms ?? null, judge_duration_ms: metrics.judge_duration_ms,
      steps: result.steps ?? null, browser_steps: result.browser_steps ?? null,
      failed_steps: result.failed_steps ?? null, incomplete_steps: result.incomplete_steps ?? null,
      model_steps: result.model_steps ?? null, model_requests: result.request_count ?? result.model_rounds ?? null,
      retries: result.retry_count ?? null, ...metrics,
      usage_missing_calls: result.usage_missing_calls ?? null,
      unpriced_calls: result.unpriced_calls ?? null,
    }
  })
}

export function metricsCsv(rows) {
  if (!rows.length) return ""
  const columns = Object.keys(rows[0])
  const cell = value => {
    if (value === null || value === undefined) return ""
    let text = String(value)
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return "\uFEFF" + [columns.join(","), ...rows.map(row => columns.map(key => cell(row[key])).join(","))].join("\r\n") + "\r\n"
}

/** The ten main columns match the task ledger; all columns use agent-only metrics. */
export function taskTable(results) {
  const number = value => Number.isFinite(value) ? value.toLocaleString("en-US") : "未知"
  const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(3)} 秒` : "未知"
  const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "未知"
  const money = value => Number.isFinite(value) ? `$${value.toFixed(8)}` : "未知"
  const columns = ["任务", "完成时间¹", "工具步骤", "模型轮次", "未缓存输入", "缓存命中", "缓存写入", "输出", "命中率", "总成本²"]
  const rows = results.map(result => {
    const usage = result.usage_metrics ?? tokenMetrics(result.tokens)
    return [result.task_id, result.duration_ms, result.steps, result.model_rounds, usage.uncached_input_tokens, usage.cache_hit_tokens, usage.cache_write_tokens, usage.output_tokens, usage.cache_hit_rate, result.cost]
  })
  const metrics = aggregateMetrics(results)
  const totals = ["合计", knownSum(rows.map(r => r[1])), knownSum(rows.map(r => r[2])), knownSum(rows.map(r => r[3])), metrics.usage_metrics.uncached_input_tokens, metrics.usage_metrics.cache_hit_tokens, metrics.usage_metrics.cache_write_tokens, metrics.usage_metrics.output_tokens, metrics.usage_metrics.cache_hit_rate, knownSum(rows.map(r => r[9]))]
  const format = row => row.map((value, i) => i === 0 ? String(value).replaceAll("|", "\\|") : i === 1 ? seconds(value) : i === 8 ? percent(value) : i === 9 ? money(value) : number(value))
  const markdown = [
    "| " + columns.join(" | ") + " |",
    "| --- | " + Array(9).fill("---:").join(" | ") + " |",
    ...rows.map(row => "| " + format(row).join(" | ") + " |"),
    "| " + format(totals).map(value => `**${value}**`).join(" | ") + " |",
    "",
    "¹ 完成时间为本次 Agent 耗时（含失败/超时），不含 Judge、截图和清理；合计为各题耗时之和，并发时不是整批墙钟耗时。模型轮次为 API 请求次数（含重试）。",
    "² 总成本为本次 Agent 的 USD 单价估算，不是实际账单；Judge 与 Agent+Judge 费用另见 task-metrics.json / summary.json，历史尝试费用另计。未知用量/价格不按 0 计算。",
    "命中率 = 缓存命中 ÷（未缓存输入 + 缓存命中 + 缓存写入），合计按 token 加权。只列已结束的任务，成功与否请查原始结果的 status/pass。",
  ].join("\n") + "\n"
  const csvRows = [...rows, totals].map(row => Object.fromEntries(columns.map((column, i) => [column, i === 1 && Number.isFinite(row[i]) ? row[i] / 1000 : row[i]])))
  return { markdown, csv: metricsCsv(csvRows) }
}
