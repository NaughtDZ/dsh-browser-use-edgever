import { LlmError } from "@deepseek-ai/dsh-llm"

function inputContent(content, role) {
  if (typeof content === "string") return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }]
  return (content ?? []).map(block => {
    if (block.type === "text") return { type: "input_text", text: block.text }
    if (block.type === "image_url") return { type: "input_image", image_url: block.image_url.url }
    throw new Error(`Unsupported Responses content: ${block.type}`)
  })
}

/** Build a stateless Responses request, retaining native encrypted reasoning and tool IDs. */
export function responsesRequest(config, messages, tools, maxTokens) {
  const input = []
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content })
    } else if (message.role === "assistant" && Array.isArray(message.responses_output)) {
      input.push(...structuredClone(message.responses_output))
    } else {
      if (message.content) input.push({ role: message.role, content: inputContent(message.content, message.role) })
      for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    }
  }
  return {
    model: config.model,
    input,
    stream: false,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(config.supportsMaxOutputTokens === false ? {} : { max_output_tokens: maxTokens }),
    ...(config.reasoningEffort && config.reasoningEffort !== "off" ? { reasoning: { effort: config.reasoningEffort } } : {}),
    ...(tools?.length ? { parallel_tool_calls: false, tools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })), tool_choice: "auto" } : {}),
  }
}

/** Normalize native response items without discarding the items needed for the next model turn. */
export function normalizeResponses(data) {
  if (data.error) {
    const reason = data.error.code
    const code = reason === "insufficient_quota" ? "QUOTA" : reason === "rate_limit_exceeded" ? "RATE_LIMIT" : reason === "invalid_api_key" ? "AUTH" : "SERVER"
    throw new LlmError("Responses endpoint returned a failed response", code)
  }
  if (!["completed", "incomplete"].includes(data.status) || !Array.isArray(data.output)) throw new LlmError("Invalid or failed Responses model response", "SERVER")
  if (data.status === "incomplete" && data.incomplete_details?.reason !== "max_output_tokens") throw new Error("Unsupported incomplete Responses model response")
  const calls = data.output.filter(item => item.type === "function_call").map(item => {
    if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") throw new LlmError("Invalid Responses function call", "SERVER")
    return { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }
  })
  const text = data.output.filter(item => item.type === "message").flatMap(item => item.content ?? []).map(block => block.type === "output_text" ? block.text : block.type === "refusal" ? block.refusal : "").join("\n")
  const reasoning = data.output.filter(item => item.type === "reasoning").flatMap(item => item.summary ?? []).map(block => block.text ?? "").join("\n")
  if (!text && !calls.length && data.status === "completed") throw new LlmError("Responses model returned no answer or tool call", "SERVER")
  return {
    id: data.id,
    model: data.model,
    choices: [{ finish_reason: data.status === "incomplete" ? "length" : calls.length ? "tool_calls" : "stop", message: {
      role: "assistant", content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
      responses_output: data.output,
    } }],
    ...(data.usage ? { usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: data.usage.input_tokens_details?.cached_tokens ?? 0 },
      completion_tokens_details: { ...data.usage.output_tokens_details, reasoning_tokens: data.usage.output_tokens_details?.reasoning_tokens ?? 0 },
    } } : {}),
  }
}
