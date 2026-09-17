import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig, publicConfig } from "../scripts/eval/config.mjs"

test("Bailian DeepSeek V4.1 Flash resolves the Responses route without exposing its credential", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-bailian-"))
  try {
    writeFileSync(join(directory, "settings.yaml"), [
      "llm-pi-ai:",
      "  providers:",
      "    bailian:",
      "      apiKeyEnv: DASHSCOPE_API_KEY",
      "      api: openai-responses",
      "      baseURL: https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "      models:",
      "        - id: deepseek-v4.1-flash",
      "          contextWindow: 1000000",
      "          maxTokens: 393216",
      "agent-default-model:",
      "  provider: bailian",
      "  model: deepseek-v4.1-flash",
      "  reasoningEffort: high",
      "",
    ].join("\n"))
    writeFileSync(join(directory, ".credentials.yaml"), "refs:\n  DASHSCOPE_API_KEY: fixture-secret\n")

    const config = loadConfig({ DSH_HOME: directory })
    assert.deepEqual(publicConfig(config.agent), {
      provider: "bailian",
      model: "deepseek-v4.1-flash",
      protocol: "openai-responses",
      baseURL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      reasoningEffort: "high",
      modelMaxTokens: 393216,
      contextWindow: 1000000,
      maxTokens: 8192,
      temperature: 1,
      supportsMaxOutputTokens: true,
    })
    assert.equal(JSON.stringify(publicConfig(config.agent)).includes("fixture-secret"), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
