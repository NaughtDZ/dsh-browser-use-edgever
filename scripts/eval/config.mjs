import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"
import { parsePricing } from "./metrics.mjs"

const reasoningEfforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const protocols = new Set(["anthropic-messages", "openai-completions", "openai-responses"])

export function validateReasoningEffort(value) {
  if (value === undefined || value === null || value === "") return undefined
  if (!reasoningEfforts.has(value)) throw new Error(`Unknown reasoning effort: ${value}`)
  return value
}

function validateProtocol(value) {
  if (!protocols.has(value)) throw new Error(`Unknown evaluation API protocol: ${value}`)
  return value
}

function inferredProtocol(provider, configuredBaseURL) {
  if (provider === "bailian") return "openai-responses"
  if (!["minimax", "minimax-cn"].includes(provider)) return "openai-completions"
  return configuredBaseURL && /\/v1\/?$/.test(configuredBaseURL) ? "openai-completions" : "anthropic-messages"
}

function defaultBaseURL(provider, protocol) {
  const host = provider === "minimax-cn" ? "https://api.minimaxi.com" : provider === "minimax" ? "https://api.minimax.io" : ""
  return host ? `${host}/${protocol === "anthropic-messages" ? "anthropic" : "v1"}` : ""
}

export function loadConfig(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), ".dsh")
  const readYaml = file => existsSync(file) ? parse(readFileSync(file, "utf8")) : {}
  const settings = readYaml(join(home, "settings.yaml"))
  const provider = env.EVAL_PROVIDER || settings["agent-default-model"]?.provider || "minimax-cn"
  const profile = settings["llm-pi-ai"]?.providers?.[provider] ?? {}
  const keyEnv = env.EVAL_API_KEY_ENV || profile.apiKeyEnv || (provider === "bailian" ? "DASHSCOPE_API_KEY" : "MINIMAX_API_KEY")
  const credentials = readYaml(join(home, ".credentials.yaml"))
  const apiKey = env.EVAL_API_KEY || env[keyEnv] || profile.apiKey || credentials.refs?.[keyEnv]
  const model = env.EVAL_MODEL || settings["agent-default-model"]?.model || (provider === "bailian" ? "deepseek-v4.1-flash" : "MiniMax-M3")
  const configuredBaseURL = env.EVAL_BASE_URL || profile.baseURL
  const protocol = validateProtocol(env.EVAL_API_PROTOCOL || profile.api || inferredProtocol(provider, configuredBaseURL))
  const baseURL = configuredBaseURL || defaultBaseURL(provider, protocol)
  const reasoningEffort = validateReasoningEffort(env.EVAL_REASONING_EFFORT ?? settings["agent-default-model"]?.reasoningEffort)
  if (!baseURL || !["https:", "http:"].includes(new URL(baseURL).protocol)) throw new Error("Set EVAL_BASE_URL or configure the DSH provider baseURL")
  if (new URL(baseURL).username || new URL(baseURL).password || new URL(baseURL).search) throw new Error("API URL must not embed credentials or query parameters")
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error(`Missing credential: ${keyEnv}; configure DSH credentials or EVAL_API_KEY`)
  const modelMaxTokens = profile.models?.find(entry => entry.id === model)?.maxTokens ?? profile.defaultMaxTokens ?? (model === "MiniMax-M3" ? 512000 : model === "deepseek-v4.1-flash" ? 393216 : 8192)
  if (!Number.isSafeInteger(modelMaxTokens) || modelMaxTokens < 1) throw new Error("Invalid configured model maxTokens")
  const contextWindow = profile.models?.find(entry => entry.id === model)?.contextWindow ?? profile.defaultContextWindow ?? (model === "deepseek-v4.1-flash" ? 1000000 : modelMaxTokens)
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) throw new Error("Invalid configured model contextWindow")
  const config = { provider, model, protocol, baseURL: baseURL.replace(/\/$/, ""), apiKey, reasoningEffort, modelMaxTokens, contextWindow, maxTokens: 8192, temperature: 1 }
  if (protocol === "openai-responses") {
    const outputLimit = env.EVAL_RESPONSES_OUTPUT_LIMIT ?? "send"
    if (!["send", "omit"].includes(outputLimit)) throw new Error("EVAL_RESPONSES_OUTPUT_LIMIT must be send or omit")
    config.supportsMaxOutputTokens = outputLimit === "send"
  }
  const judgeBaseURL = (env.EVAL_JUDGE_BASE_URL || config.baseURL).replace(/\/$/, "")
  const judgeProtocol = validateProtocol(env.EVAL_JUDGE_API_PROTOCOL || (env.EVAL_JUDGE_BASE_URL ? inferredProtocol(provider, judgeBaseURL) : protocol))
  const judge = { ...config, model: env.EVAL_JUDGE_MODEL || model, protocol: judgeProtocol, baseURL: judgeBaseURL, apiKey: env.EVAL_JUDGE_API_KEY || apiKey, reasoningEffort: validateReasoningEffort(env.EVAL_JUDGE_REASONING_EFFORT ?? reasoningEffort) }
  const pricing = parsePricing(env.EVAL_PRICING_JSON, "EVAL_PRICING_JSON")
  if (pricing) config.pricing = pricing
  const judgePricing = parsePricing(env.EVAL_JUDGE_PRICING_JSON, "EVAL_JUDGE_PRICING_JSON")
    ?? (judge.model === model && judge.baseURL === config.baseURL ? pricing : undefined)
  if (judgePricing) judge.pricing = judgePricing
  if (new URL(judge.baseURL).username || new URL(judge.baseURL).password || new URL(judge.baseURL).search) throw new Error("Judge URL must not embed credentials")
  return { agent: config, judge }
}
export function publicConfig(config) {
  const { apiKey, ...safe } = config
  return safe
}
