import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { REFERENCE_SHA, hash, validateTasks, writeJson } from "./core.mjs"

const target = resolve(fileURLToPath(new URL("../../assets/benchmark/", import.meta.url)))
mkdirSync(target, { recursive: true })
const root = `https://raw.githubusercontent.com/oktton/opencode-browser/${REFERENCE_SHA}/`
async function source(path) {
  const local = process.argv[2]
  if (local) return readFileSync(join(local, path.split("/").at(-1)), "utf8")
  const response = await fetch(root + path, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  return response.text()
}
const dataRaw = await source("assets/benchmark/WebVoyager_data.json")
const resultsRaw = await source("assets/benchmark/results/merged/results.ndjson")
const judgmentRaw = await source("assets/benchmark/results/merged/webvoyager_judgments.json")
const dataset = JSON.parse(dataRaw)
const results = resultsRaw.trim().split(/\r?\n/).map(JSON.parse)
const judgments = JSON.parse(judgmentRaw)
const ids = results.map(r => r.task_id)
if (ids.length !== 109 || new Set(ids).size !== 109) throw new Error("Reference is not the expected unique 109-task subset")
const tasks = validateTasks(ids.map(id => dataset.find(t => t.task_id === id)))
if (tasks.some(t => !["www.allrecipes.com", "www.apple.com", "www.amazon.com"].includes(new URL(t.website).hostname))) throw new Error("Unexpected reference site")
const passed = judgments.filter(j => j.pass === true).length
if (passed !== 80 || judgments.length !== 109) throw new Error("Unexpected reference judgments")
writeJson(join(target, "webvoyager-109.json"), tasks)
writeJson(join(target, "reference.json"), {
  repository: "https://github.com/oktton/opencode-browser", commit: REFERENCE_SHA,
  dataset_source: root + "assets/benchmark/WebVoyager_data.json", dataset_sha256: hash(dataRaw), dataset_total: dataset.length,
  selection_source: root + "assets/benchmark/results/merged/results.ndjson", selection_sha256: hash(resultsRaw),
  judgments_source: root + "assets/benchmark/results/merged/webvoyager_judgments.json", judgments_sha256: hash(judgmentRaw),
  subset_sha256: hash(tasks), task_ids: ids, total: 109, passed,
  success_rate: passed / 109, avg_steps: results.reduce((s, r) => s + r.steps, 0) / 109,
  avg_duration_s: results.reduce((s, r) => s + r.duration_ms, 0) / 109000,
  avg_cost_usd: results.reduce((s, r) => s + r.cost, 0) / 109,
  per_site: Object.fromEntries([...new Set(tasks.map(t => new URL(t.website).hostname))].map(site => {
    const rows = results.filter(r => new URL(r.website).hostname === site)
    return [site, { total: rows.length, passed: rows.filter(r => judgments.find(j => j.task_id === r.task_id)?.pass).length }]
  })),
  caveats: ["Reference trace includes non-browser tools (webfetch/bash/read/grep)", "Published judgments omit judge model identity", "judge.ts rejects errors; judge-prompt.md allows valid answers from errors", "Answer plausibility judge differs from official WebVoyager screenshot evaluation", "All tasks are pinned verbatim; historic dates and obsolete products are not rewritten"],
})
writeFileSync(join(target, "LICENSE.txt"), await source("LICENSE"))
console.log(`Prepared ${tasks.length} exact reference tasks; sha256=${hash(tasks)}`)
