import { existsSync, mkdirSync, readdirSync, writeFileSync, renameSync } from "node:fs"
import { join, resolve, relative, isAbsolute } from "node:path"
import { hash, readJson, readLines, writeJson, redact, resumeAction } from "./core.mjs"

export function writeResultIndex(directory, results) {
  const path = join(directory, "results.ndjson")
  writeFileSync(`${path}.tmp`, results.map(r => JSON.stringify(r)).join("\n") + "\n")
  renameSync(`${path}.tmp`, path)
}

/** Original attempts remain immutable; committed revisions form a checked chain. */
export function readRunResults(directory) {
  const path = join(directory, "results.ndjson")
  const results = existsSync(path) ? readLines(path) : []
  const updates = join(directory, "result-revisions")
  if (!existsSync(updates)) return results
  for (const file of readdirSync(updates).filter(f => /^\d{8}\.json$/.test(f)).sort()) {
    const revision = readJson(join(updates, file))
    const index = results.findIndex(r => r.task_id === revision.result.task_id)
    if (index < 0 || hash(results[index]) !== revision.previous) throw new Error(`Broken result revision chain: ${file}`)
    results[index] = revision.result
  }
  return results
}

export function reviseResult(directory, previous, result, secrets = []) {
  const path = join(directory, "result-revisions")
  mkdirSync(path, { recursive: true })
  const names = readdirSync(path).filter(f => /^\d{8}\.json$/.test(f)).sort()
  const next = (names.length ? Number(names.at(-1).slice(0, 8)) : 0) + 1
  writeJson(join(path, `${String(next).padStart(8, "0")}.json`), { previous: hash(previous), result: redact(result, secrets) })
}

export function historicalCosts(directory) {
  const path = join(directory, "results.ndjson")
  const prior = new Map((existsSync(path) ? readLines(path) : []).map(r => [r.task_id, r]))
  const updates = join(directory, "result-revisions")
  let superseded_attempts = 0, superseded_agent_cost_observed = 0, superseded_judge_cost_observed = 0
  for (const file of existsSync(updates) ? readdirSync(updates).filter(f => /^\d{8}\.json$/.test(f)).sort() : []) {
    const { result } = readJson(join(updates, file))
    const old = prior.get(result.task_id)
    if ((old?.attempt_number ?? 1) !== (result.attempt_number ?? 1)) {
      superseded_attempts++
      superseded_agent_cost_observed += old?.cost_observed ?? old?.cost ?? 0
    }
    superseded_judge_cost_observed += old?.judge_result?.cost_observed ?? old?.judge_result?.cost ?? 0
    prior.set(result.task_id, result)
  }
  return { superseded_attempts, superseded_agent_cost_observed, superseded_judge_cost_observed, historical_cost_basis: "Observed subtotals only; excludes unpriced requests and orphan partial traces" }
}

export function evidenceDirectory(directory, result) {
  const target = resolve(directory, result.attempt_directory ?? result.task_id)
  const rel = relative(resolve(directory), target)
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Attempt directory must stay inside the run")
  return target
}

export function nextAttempt(directory, taskId, previous) {
  let number = previous ? (previous.attempt_number ?? 1) + 1 : 1
  while (true) {
    const relativePath = number === 1 ? taskId : join(taskId, "attempts", String(number))
    const path = join(directory, relativePath)
    // A persisted result with no parent revision is recovered, not executed again.
    if (existsSync(join(path, "result.json")) || !existsSync(join(path, "trace.ndjson"))) return { path, relativePath, number }
    // Preserve an interrupted child's partial trace and use a new attempt directory.
    number++
  }
}

/** Register orphan results before planning, so an orphan quota failure retries in this resume. */
export function recoverAttemptResults(directory, tasks, judgeMode) {
  const results = readRunResults(directory)
  for (const task of tasks) {
    let previous = results.find(result => result.task_id === task.task_id)
    while (resumeAction(previous, judgeMode) === "run") {
      const attempt = nextAttempt(directory, task.task_id, previous)
      const path = join(attempt.path, "result.json")
      if (!existsSync(path)) break
      const saved = readJson(path)
      if (saved.task_id !== task.task_id || !["completed", "error", "timeout", "step_limit"].includes(saved.status)) throw new Error(`Invalid persisted attempt for ${task.task_id}`)
      const result = { ...saved, attempt_number: attempt.number, attempt_directory: attempt.relativePath }
      if (previous) {
        reviseResult(directory, previous, result)
        results[results.findIndex(row => row.task_id === task.task_id)] = result
      } else {
        const originalPath = join(directory, "results.ndjson")
        writeResultIndex(directory, [...(existsSync(originalPath) ? readLines(originalPath) : []), result])
        results.push(result)
      }
      previous = result
    }
  }
  return results
}
