import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm"
import { normalizeUsage, estimateCost, infrastructureFailure } from "./core.mjs"
import { responsesRequest, normalizeResponses } from "./responses.mjs"
import { outputCacheTokens } from "./metrics.mjs"

function retryAfterMs(response) {
  const value = response.headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function httpFailure(response, detail) {
  const message = `Model HTTP ${response.status}${detail ? `: ${detail}` : ""}`
  const infrastructure = infrastructureFailure(message)
  const code = infrastructure === "quota_exhausted" ? "QUOTA"
    : response.status === 429 ? "RATE_LIMIT"
      : response.status === 408 ? "TIMEOUT"
        : response.status >= 500 ? "SERVER"
          : [401, 403].includes(response.status) ? "AUTH" : "INVALID_REQUEST"
  const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || undefined
  const retryDelay = code === "RATE_LIMIT" ? retryAfterMs(response) : undefined
  return new LlmError(message, code, {
    status: response.status,
    ...(retryDelay ? { providerRetryAfterMs: retryDelay } : {}),
    ...(requestId ? { requestId } : {}),
  })
}

function errorDetail(body, apiKey) {
  const values = [body.error?.code, body.error?.type, body.error?.message, body.base_resp?.status_code, body.base_resp?.status_msg]
  const detail = values.filter(value => value !== undefined && value !== null).join(": ")
  return (apiKey ? detail.split(apiKey).join("[REDACTED]") : detail).slice(0, 1000)
}

// Match the installed DSH Anthropic adapter; larger aliases clamp to its High budget.
const thinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 }

function endpoint(config) {
  if (config.protocol === "anthropic-messages") return `${config.baseURL}${/\/v1$/.test(config.baseURL) ? "" : "/v1"}/messages`
  if (config.protocol === "openai-responses") return `${config.baseURL}/responses`
  return `${config.baseURL}/chat/completions`
}

function dataImage(block) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(block.image_url?.url || "")
  if (!match) throw new Error("Anthropic image input requires a base64 data URL")
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
}

function contentBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap(block => block.type === "text" ? [{ type: "text", text: block.text }] : block.type === "image_url" ? [dataImage(block)] : [])
}

function anthropicConversation(messages) {
  const system = []
  const result = []
  const append = (role, content) => {
    if (!content.length) return
    const last = result.at(-1)
    if (last?.role === role) last.content.push(...content)
    else result.push({ role, content })
  }
  for (const message of messages) {
    if (message.role === "system") {
      system.push(...contentBlocks(message.content).filter(block => block.type === "text").map(block => block.text))
      continue
    }
    if (message.role === "user") {
      append("user", contentBlocks(message.content))
      continue
    }
    if (message.role === "tool") {
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: contentBlocks(message.content), ...(message.is_error ? { is_error: true } : {}) }])
      continue
    }
    if (message.role === "assistant") {
      if (Array.isArray(message.anthropic_content)) {
        append("assistant", structuredClone(message.anthropic_content))
        continue
      }
      const blocks = contentBlocks(message.content)
      for (const call of message.tool_calls ?? []) {
        let input
        try { input = JSON.parse(call.function.arguments) } catch { throw new Error(`Invalid tool arguments for ${call.function.name}`) }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input })
      }
      append("assistant", blocks)
    }
  }
  return { ...(system.length ? { system: system.join("\n\n") } : {}), messages: result }
}

function anthropicRequest(config, messages, tools, maxTokens) {
  const effort = config.reasoningEffort
  const budget = effort && effort !== "off" ? thinkingBudgets[effort] : undefined
  const ceiling = Math.min(maxTokens + (budget || 0), config.modelMaxTokens || maxTokens + (budget || 0))
  return {
    model: config.model,
    ...anthropicConversation(messages),
    stream: false,
    max_tokens: ceiling,
    ...(effort === "off" ? { thinking: { type: "disabled" } } : budget ? { thinking: { type: "enabled", budget_tokens: Math.min(budget, Math.max(0, ceiling - 1024)) } } : {}),
    ...(!budget && config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(tools?.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })), tool_choice: { type: "auto" } } : {}),
  }
}

function normalizeAnthropic(data) {
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) throw new Error(`MiniMax API error ${data.base_resp.status_code}`)
  if (!Array.isArray(data.content) || !["end_turn", "stop_sequence", "tool_use", "max_tokens"].includes(data.stop_reason)) throw new Error("Invalid or unsupported Anthropic model response")
  const text = data.content.filter(block => block.type === "text").map(block => block.text).join("\n")
  const reasoning = data.content.filter(block => block.type === "thinking").map(block => block.thinking).join("\n")
  const calls = data.content.filter(block => block.type === "tool_use").map(block => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }))
  const cacheRead = data.usage?.cache_read_input_tokens ?? 0
  const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0
  const input = data.usage?.input_tokens
  const output = data.usage?.output_tokens
  const usage = Number.isFinite(input) && Number.isFinite(output) ? {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    prompt_tokens_details: { cached_tokens: cacheRead },
    cache_creation_input_tokens: cacheWrite,
    completion_tokens_details: { ...data.usage.output_tokens_details, reasoning_tokens: data.usage.output_tokens_details?.thinking_tokens ?? 0 },
  } : undefined
  return {
    id: data.id,
    model: data.model,
    choices: [{
      finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason === "max_tokens" ? "length" : "stop",
      message: { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}), anthropic_content: data.content },
    }],
    ...(usage ? { usage } : {}),
  }
}

export async function complete(config, messages, { tools, signal, maxTokens = config.maxTokens } = {}) {
  const requestTimeout = AbortSignal.timeout(120000)
  let response
  try {
    const anthropic = config.protocol === "anthropic-messages"
    response = await fetch(endpoint(config), {
      method: "POST",
      redirect: "error",
      headers: anthropic ? { "Content-Type": "application/json", "X-Api-Key": config.apiKey, "Anthropic-Version": "2023-06-01" } : { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
      body: JSON.stringify(config.protocol === "openai-responses" ? responsesRequest(config, messages, tools, maxTokens) : anthropic ? anthropicRequest(config, messages, tools, maxTokens) : { model: config.model, messages, stream: false, reasoning_split: true, temperature: config.temperature, max_completion_tokens: maxTokens, ...(config.reasoningEffort && config.reasoningEffort !== "off" ? { reasoning_effort: config.reasoningEffort } : {}), ...(tools?.length ? { tools: tools.map(t => ({ type: "function", function: t })), tool_choice: "auto" } : {}) }),
    })
  } catch (error) {
    const callerTimedOut = signal?.aborted && signal.reason?.name === "TimeoutError"
    if (signal?.aborted && !callerTimedOut) throw error
    const code = callerTimedOut || requestTimeout.aborted ? "TIMEOUT" : "TRANSPORT"
    throw new LlmError(`Model ${code === "TIMEOUT" ? "request timed out" : `transport error: ${error.message}`}`, code, { cause: error })
  }
  if (!response.ok) {
    let detail = ""
    try { detail = errorDetail(await response.json(), config.apiKey) } catch { /* HTTP status remains authoritative when the error body is not JSON. */ }
    throw httpFailure(response, detail)
  }
  let data
  try { data = await response.json() }
  catch (error) {
    if (signal?.aborted && signal.reason?.name !== "TimeoutError") throw error
    const timeout = signal?.reason?.name === "TimeoutError" || requestTimeout.aborted
    throw new LlmError(timeout ? "Model response body timed out" : "Model response body was invalid or interrupted", timeout ? "TIMEOUT" : "SERVER", { cause: error })
  }
  if (data.error || (data.base_resp?.status_code && data.base_resp.status_code !== 0)) {
    const detail = errorDetail(data, config.apiKey)
    if (infrastructureFailure(detail) === "quota_exhausted") throw new LlmError(`Model quota exhausted: ${detail}`, "QUOTA")
  }
  if (config.protocol === "openai-responses") return normalizeResponses(data)
  if (config.protocol === "anthropic-messages") return normalizeAnthropic(data)
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) throw new Error(`MiniMax API error ${data.base_resp.status_code}`)
  if (!data.choices?.[0]?.message || !["stop", "tool_calls", "length"].includes(data.choices[0].finish_reason)) throw new Error("Invalid or unsupported model response")
  return data
}

export function wireMessages(options, images = new Map()) {
  const result = options.system ? [{ role: "system", content: options.system }] : []
  let pendingImages = []
  function content(blocks) {
    return blocks.flatMap(block => {
      if (block.type === "text") return [{ type: "text", text: block.text }]
      if (block.type === "image") {
        const image = images.get(String(block.attachment.attachmentId))
        if (!image) throw new Error("Image attachment unavailable")
        return [{ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}` } }]
      }
      if (block.type === "reasoning") return []
      throw new Error(`Unsupported message block: ${block.type}`)
    })
  }
  for (const message of options.messages) {
    const isToolMessage = message.content.some(b => b.type === "tool-result")
    if (!isToolMessage && pendingImages.length) {
      result.push({ role: "user", content: content(pendingImages) })
      pendingImages = []
    }
    if (message.role === "assistant") {
      const calls = message.content.filter(b => b.type === "tool-call").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }))
      const replay = message.source?.replayState?.response ?? {}
      result.push({ role: "assistant", content: message.content.filter(b => b.type === "text").map(b => b.text).join("\n") || null, ...(calls.length ? { tool_calls: calls } : {}), ...(replay.reasoning_details ? { reasoning_details: replay.reasoning_details } : {}), ...(replay.reasoning_content ? { reasoning_content: replay.reasoning_content } : {}), ...(replay.anthropic_content ? { anthropic_content: replay.anthropic_content } : {}), ...(replay.responses_output ? { responses_output: replay.responses_output } : {}) })
    } else {
      const tools = message.content.filter(b => b.type === "tool-result")
      if (tools.length) {
        for (const tool of tools) {
          result.push({ role: "tool", tool_call_id: tool.toolCallId, content: tool.content.filter(b => b.type === "text").map(b => b.text).join("\n") || (tool.isError ? "Tool failed" : "Image attached in next message") })
          const visual = tool.content.filter(b => b.type === "image")
          pendingImages.push(...visual)
        }
      } else result.push({ role: "user", content: content(message.content) })
    }
  }
  if (pendingImages.length) result.push({ role: "user", content: content(pendingImages) })
  return result
}

export class EvaluationAdapter extends LlmAdapter {
  calls = []
  constructor(config, images, record, request = complete) { super(); this.config = config; this.images = images; this.record = record; this.request = request }
  async resolveModel(provider, id) {
    return {
      provider, id, name: id,
      ...(Number.isSafeInteger(this.config.contextWindow ?? this.config.modelMaxTokens) ? { context: { contextWindow: this.config.contextWindow ?? this.config.modelMaxTokens } } : {}),
      ...(Number.isSafeInteger(this.config.maxTokens) ? { defaultMaxTokens: this.config.maxTokens } : {}),
      ...(this.config.reasoningEffort ? { reasoning: { efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(effort => ({ id: effort, name: effort })), defaultEffort: this.config.reasoningEffort } } : {}),
    }
  }
  async *stream(options) {
    const start = Date.now()
    const call = { call_index: this.calls.length + 1, started_at: new Date(start).toISOString(), finished_at: null, usage: null, cost: null, duration_ms: 0, status: "incomplete" }
    this.record({ type: "model/request", model: options.model, messages: options.messages, system: options.system, tools: options.tools, ...call })
    this.calls.push(call)
    let data
    try { data = await this.request({ ...this.config, reasoningEffort: options.reasoningEffort ?? this.config.reasoningEffort }, wireMessages(options, this.images), { tools: options.tools, signal: options.signal }) }
    catch (error) { call.finished_at = new Date().toISOString(); call.duration_ms = Date.now() - start; call.status = "error"; call.errorKind = infrastructureFailure(error); this.record({ type: "model/error", error: error.message, ...call }); throw error }
    call.usage = normalizeUsage(data.usage)
    call.cost = estimateCost(call.usage, this.config.model, this.config.pricing)
    call.raw_usage = data.usage ?? null
    call.output_cache_tokens = outputCacheTokens(data.usage)
    call.finished_at = new Date().toISOString()
    call.status = "success"
    call.duration_ms = Date.now() - start
    this.record({ type: "model/response", response: data, ...call })
    const choice = data.choices[0]
    const message = choice.message
    const blocks = []
    const reasoning = message.reasoning_content || message.reasoning_details?.map(r => r.text || "").join("")
    if (reasoning) blocks.push({ type: "reasoning", text: reasoning })
    if (message.content) blocks.push({ type: "text", text: message.content })
    for (const t of message.tool_calls ?? []) blocks.push({ type: "tool-call", id: t.id, name: t.function.name, arguments: t.function.arguments })
    for (const [index, block] of blocks.entries()) {
      yield { type: "block-start", index, blockType: block.type }
      if (block.type === "tool-call") yield { type: "tool-call-delta", index, id: block.id, name: block.name, argumentsDelta: block.arguments }
      else yield { type: `${block.type}-delta`, index, text: block.text }
      yield { type: "block-end", index, block }
    }
    if (call.usage) yield { type: "usage", usage: { inputTokens: call.usage.input, outputTokens: call.usage.output, cacheReadTokens: call.usage.cache_read, cacheWriteTokens: call.usage.cache_write, reasoningTokens: call.usage.reasoning } }
    const replay = { ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}), ...(message.reasoning_details !== undefined ? { reasoning_details: message.reasoning_details } : {}), ...(message.anthropic_content !== undefined ? { anthropic_content: message.anthropic_content } : {}), ...(message.responses_output !== undefined ? { responses_output: message.responses_output } : {}) }
    yield { type: "finish", reason: { kind: choice.finish_reason === "length" ? "max-tokens" : message.tool_calls?.length ? "tool-calls" : "stop" }, replayState: { response: replay } }
  }
}
