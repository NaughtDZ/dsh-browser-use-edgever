import test from "node:test"
import assert from "node:assert/strict"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import * as b from "../lib/index.js"

const fresh = () => Session.create(SessionId("evidence-test"))
function observe(s, { visitId = "visit-a", tabId = "tab0", runtimeId = "live", url = "https://jobs.test/list", extraction = [{ title: "Engineer", company: "Acme" }], tool = "browser_observe", mode = "full" } = {}) {
  const o = { version: 1, runtimeId, tabId, visitId, url, domId: `dom${s.seq}`, mode, output: "<p>Engineer at Acme</p>", fullOutput: "<p>Engineer at Acme</p>", extraction, capturedAt: "2026-09-13T00:00:00Z" }
  const callId = `call${s.seq}`
  s.append("tool/call", { turn: 1, step: 1, callId, name: tool, arguments: "{}" })
  s.append("tool/result", { turn: 1, step: 1, meta: { browserContext: { version: 1, observation: o } }, message: createUserMessage({ source: { kind: "tool", callId }, content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: o.output }] }] }) }, { surfaceOp: "append" })
  return b.browserObservationId(o)
}
const define = s => b.defineEvidenceTask(s, { mode: "records", objective: "Find jobs with title and company", requiredFields: ["title", "company"], minRecords: 1 })
const field = (s, id, name) => ({ name, sourceRef: b.observationRecords(s, id)[0].fields.find(f => f.name === `/${name}`).sourceRef })

test("record exact source text directly without repeated recall and persist canonical spans", () => {
  const s = fresh()
  define(s)
  const id = observe(s)
  b.recordEvidence(s, [{ recordId: "job", fields: [
    { name: "title", sourceRef: { observationId: id, query: "Engineer" } },
    { name: "company", sourceRef: { observationId: id, query: "Acme" } },
  ] }])
  assert.equal(b.checkEvidenceCoverage(s).status, "complete")
  const saved = b.taskRecords(s)[0].fields[0]
  assert.equal(saved.value, "Engineer")
  assert.deepEqual(saved.sourceRef, { observationId: id, start: 3, end: 11 })
  assert.throws(() => b.resolveSourceRef(s, { observationId: id, query: "Invented employer" }), /not found/)
  assert.throws(() => b.resolveSourceRef(s, { observationId: id, query: "e" }), /ambiguous/)
  assert.throws(() => b.resolveSourceRef(s, { observationId: id, query: "Engineer", start: 3, end: 11 }), /not both|only one/)
  assert.throws(() => b.resolveSourceRef(s, { observationId: id, query: "" }), /nonempty/)
})

test("bundles group full snapshots and scrolling per visit, preserve tab return and split reload/same URL revisits", () => {
  const s = fresh()
  const a = observe(s)
  observe(s, { tool: "browser_scroll_next_screen" })
  observe(s, { tabId: "tab1", visitId: "visit-b" })
  observe(s, { tool: "browser_switch_tab" })
  observe(s, { visitId: "visit-reload", tool: "browser_refresh" })
  observe(s, { runtimeId: "restart", visitId: "visit-a" })
  const bundles = b.evidenceBundles(s)
  assert.equal(bundles.length, 4)
  assert.equal(bundles[0].observationIds.length, 3)
  assert.equal(bundles[0].observationIds[0], a)
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(s.events)))
  assert.deepEqual(b.evidenceBundles(replay), bundles)
})

test("source references resolve exact JSON leaves including escaped keys, false, zero and raw text spans", () => {
  const s = fresh()
  const id = observe(s, { extraction: [{ "a/b~c": { active: false, count: 0 } }] })
  const record = b.observationRecords(s, id)[0]
  assert.equal(b.resolveSourceRef(s, record.fields[0].sourceRef).value, false)
  assert.equal(record.fields[0].name, "/a~1b~0c/active")
  assert.equal(b.resolveSourceRef(s, record.fields[1].sourceRef).value, 0)
  assert.equal(b.resolveSourceRef(s, { observationId: id, start: 3, end: 11 }).value, "Engineer")
  assert.throws(() => b.resolveSourceRef(s, { ...record.fields[0].sourceRef, field: "/__proto__" }), /Unknown source/)
  assert.throws(() => b.resolveSourceRef(fresh(), record.fields[0].sourceRef), /Unknown browser/)
  assert.throws(() => b.resolveSourceRef(s, { observationId: id, start: 3, end: 9999 }), /end/)
})

test("coverage reports missing fields per record, merges supplements and rechecks mutations without stale tickets", () => {
  const s = fresh()
  define(s)
  const id = observe(s)
  b.recordEvidence(s, [{ recordId: "job-1", fields: [field(s, id, "title")] }])
  assert.deepEqual(b.checkEvidenceCoverage(s).missing.map(m => m.field), ["company"])
  b.recordEvidence(s, [{ recordId: "job-1", fields: [field(s, id, "company")] }])
  assert.equal(b.checkEvidenceCoverage(s).status, "complete")
  b.recordEvidence(s, [{ recordId: "job-2", fields: [field(s, id, "title")] }])
  assert.equal(b.checkEvidenceCoverage(s).status, "partial")
  assert.equal(b.checkEvidenceCoverage(s).missing[0].recordId, "job-2")
  assert.throws(() => b.defineEvidenceTask(s, { mode: "interaction", objective: "skip" }), /already fixed/)
  assert.throws(() => b.defineEvidenceTask(s, { mode: "records", objective: "Find jobs", requiredFields: ["title"] }), /already fixed/)
})

test("record writes validate the whole batch and defer durable context until tool results are committed", () => {
  const s = fresh()
  define(s)
  const id = observe(s)
  const good = { recordId: "job", fields: [field(s, id, "title"), field(s, id, "company")] }
  const before = s.seq
  const deferred = []
  assert.throws(() => b.recordEvidence(s, [good, { recordId: "bad", fields: [{ name: "title", sourceRef: { observationId: "foreign", start: 0, end: 3 } }] }], m => deferred.push(m)))
  assert.equal(s.seq, before)
  assert.equal(deferred.length, 0)
  assert.throws(() => b.recordEvidence(s, [{ recordId: "bad", fields: [{ ...good.fields[0], value: "invented" }] }]), /resolved by the host/)
  b.recordEvidence(s, [good], m => deferred.push(m))
  assert.equal(b.checkEvidenceCoverage(s).status, "partial")
  s.append("user/message", deferred[0], { surfaceOp: "append" })
  assert.equal(b.checkEvidenceCoverage(s).status, "complete")
})

test("archives and field coverage survive whole-surface compaction, replay and a new turn needs its own contract", () => {
  const s = fresh()
  define(s)
  const id = observe(s)
  b.recordEvidence(s, [{ recordId: "job", fields: [field(s, id, "title"), field(s, id, "company")] }])
  const nodes = [...s.surface.nodes]
  s.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: "compactor" }, content: [{ type: "text", text: "Summary without evidence" }] }), { surfaceOp: { op: "replace", start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes })
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(s.events)))
  assert.equal(b.checkEvidenceCoverage(replay).status, "complete")
  assert.equal(b.taskRecords(replay)[0].fields[0].value, "Engineer")
  assert.equal(b.recallEvidence(replay, { mode: "bundles" }).total, 1)
  assert.equal(b.recallEvidence(replay, { observationId: id }).sourceRecords.length, 1)
  assert.equal(b.checkEvidenceCoverage(replay, 2).status, "partial")
  assert.equal(b.taskRecords(replay, 2).length, 0)
})

test("null or empty source fields cannot satisfy coverage and every record is checked", () => {
  const s = fresh()
  define(s)
  const id = observe(s, { extraction: [{ title: "", company: null }] })
  b.recordEvidence(s, [{ recordId: "empty", fields: [field(s, id, "title"), field(s, id, "company")] }])
  assert.equal(b.checkEvidenceCoverage(s).missing.length, 2)
})

test("deferred task declarations cannot weaken a reserved contract in the same tool batch", () => {
  const s = fresh()
  const deferred = []
  const contract = { mode: "records", objective: "Find jobs", requiredFields: ["title", "company"] }
  const task = b.defineEvidenceTask(s, contract, m => deferred.push(m))
  assert.equal(b.checkEvidenceCoverage(s).task, undefined)
  assert.throws(() => b.defineEvidenceTask(s, { mode: "interaction", objective: "skip" }, m => deferred.push(m)), /already fixed/)
  assert.deepEqual(b.defineEvidenceTask(s, contract, m => deferred.push(m)), task)
  assert.equal(deferred.length, 1)
  s.append("user/message", deferred[0], { surfaceOp: "append" })
  assert.deepEqual(b.checkEvidenceCoverage(s).task, task)
})
