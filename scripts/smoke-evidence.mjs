// Real Host and Chromium with deterministic decisions: visit grouping and final-stop recovery.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { checkEvidenceCoverage, evidenceBundles, taskRecords } from "../lib/index.js"
import { assertToolProtocol } from "./assert-tool-protocol.mjs"

const flattened = messages => messages.flatMap(m => m.content).flatMap(b => b.type === "tool-result" ? b.content : [b]).filter(b => b.type === "text").map(b => b.text).join("\n")
function lastResult(messages) {
  const result = messages.flatMap(m => m.content).filter(b => b.type === "tool-result").at(-1)
  const text = result.content.find(c => c.type === "text").text
  return JSON.parse(text.slice(text.indexOf("\n") + 1))
}
async function* answer(text) {
  yield { type: "block-start", index: 0, blockType: "text" }
  yield { type: "text-delta", index: 0, text }
  yield { type: "block-end", index: 0, block: { type: "text", text } }
  yield { type: "finish", reason: { kind: "stop" } }
}
async function* call(name, args, n) {
  const id = `evidence-${n}`
  const argumentsJson = JSON.stringify(args)
  yield { type: "block-start", index: 0, blockType: "tool-call" }
  yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: argumentsJson }
  yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: argumentsJson } }
  yield { type: "finish", reason: { kind: "tool-calls" } }
}
export async function runEvidenceSmoke(ctx) {
  let secondPageVisits = 0
  const server = createServer((req, res) => {
    if (req.url === "/second") secondPageVisits++
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end(`<title>Evidence jobs</title><main><h1>Engineer</h1><p id="company">Acme</p><time>2026-09-12</time><button onclick="document.body.dataset.clicked='yes'">Inspect</button><div style="height:2200px">More jobs</div></main>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const sessions = []
  class Adapter extends LlmAdapter {
    step = 0
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(options) {
      assertToolProtocol(options.messages)
      const text = flattened(options.messages)
      const latest = text.match(/Latest observation: (obs-[a-f0-9]+)\./)?.[1]
      let action
      switch (++this.step) {
        case 1: action = ["browser_define_task", { mode: "records", objective: "Collect one job with title, company and publication date", requiredFields: ["title", "company", "publishedAt"], minRecords: 1 }]; break
        case 2: action = ["browser_start", { url: origin }]; break
        case 3: action = ["browser_execute_script", { script: "return [{title:document.querySelector('h1').textContent,company:document.querySelector('#company').textContent,publishedAt:document.querySelector('time').textContent}]" }]; break
        case 4: this.sourceId = latest; action = ["browser_recall", { observationId: latest, limit: 3000 }]; break
        case 5: {
          const record = lastResult(options.messages).sourceRecords[0]
          this.fields = record.fields.map(f => ({ name: f.name.slice(1), sourceRef: f.sourceRef }))
          action = ["browser_record_facts", { records: [{ recordId: "job-A", fields: this.fields.filter(f => f.name !== "publishedAt") }] }]
          break
        }
        case 6: action = ["browser_scroll_next_screen", { container: 0, direction: "down" }]; break
        case 7: action = ["browser_goto", { url: `${origin}/second` }]; break
        case 8: action = ["browser_check_coverage", {}]; break
        case 9:
          assert.equal(lastResult(options.messages).status, "partial")
          assert.equal(secondPageVisits, 1, "missing publication date must not block navigation")
          yield* answer("Premature completion attempt")
          return
        case 10:
          assert.match(text, /Completion is not accepted/)
          assert.match(text, /publishedAt/)
          action = ["browser_recall", { observationId: this.sourceId }]
          break
        case 11:
          assert.equal(lastResult(options.messages).sourceRecords[0].fields.find(f => f.name === "/publishedAt").value, "2026-09-12")
          action = ["browser_record_facts", { records: [{ recordId: "job-A", fields: this.fields.filter(f => f.name === "publishedAt") }] }]
          break
        case 12: action = ["browser_refresh", {}]; break
        case 13: action = ["browser_check_coverage", {}]; break
        case 14: action = ["browser_recall", { mode: "records" }]; break
        default:
          assert.equal(lastResult(options.messages).records[0].fields.length, 3)
          yield* answer("Engineer at Acme, published 2026-09-12; source fields complete.")
          return
      }
      yield* call(...action, this.step)
    }
  }
  try {
    const adapter = new Adapter()
    ctx.llm.registerAdapter(["evidence-fixture"], adapter)
    const agent = await ctx.agentLoop.create(SessionId("evidence-host"), { provider: "evidence-fixture", model: "fixture" })
    sessions.push(String(agent.id))
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Collect a job with title, company and publication date." }] }))
    await agent.whenIdle()
    const agentEvents = () => agent.session.snapshotEvents()
    assert.equal(adapter.step, 15, JSON.stringify(agentEvents().slice(-2)))
    assert.equal(agentEvents().filter(e => e.type === "turn/end").at(-1).data.reason.kind, "completed")
    assert.equal(checkEvidenceCoverage(agent.session).status, "complete")
    const bundles = evidenceBundles(agent.session)
    assert.equal(bundles.length, 3, "original visit, second URL and same-URL refresh are separate visits")
    assert.equal(bundles[0].observationIds.length, 3, "start, extraction and scroll share a visit")
    const gates = agentEvents().filter(e => e.type === "user/message" && e.surfaceOp === "append" && e.data.source.plugin === "dsh-browser:completion-gate")
    assert.equal(gates.length, 1)
    // Host 0.1.5 protects the leading system node, so the simulated external compactor
    // rewrites every node after it.
    const nodes = [...agent.session.surface.nodes].slice(1)
    agent.session.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: "compactor" }, content: [{ type: "text", text: "Summary without records" }] }), { surfaceOp: { op: "replace", startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: nodes })
    const replay = Session.create(agent.id, JSON.parse(JSON.stringify(agentEvents())))
    ctx.browserRuntime.prepareContext(replay)
    assert.equal(checkEvidenceCoverage(replay).status, "complete")
    assert.deepEqual(taskRecords(replay), taskRecords(agent.session))

    // Missing task specification and repeated ignored recovery must not end as completed.
    class IgnoringAdapter extends LlmAdapter {
      step = 0
      async resolveModel(provider, id) { return { provider, id, name: id } }
      async *stream(options) {
        assertToolProtocol(options.messages)
        if (++this.step === 1) yield* call("browser_start", { url: origin }, this.step)
        else yield* answer("done without evidence")
      }
    }
    const ignoring = new IgnoringAdapter()
    ctx.llm.registerAdapter(["ignoring-fixture"], ignoring)
    const blocked = await ctx.agentLoop.create(SessionId("evidence-ignored"), { provider: "ignoring-fixture", model: "fixture" })
    sessions.push(String(blocked.id))
    blocked.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Find a job with company and date" }] }))
    await blocked.whenIdle()
    assert.equal(ignoring.step, 5)
    assert.equal(blocked.session.snapshotEvents().filter(e => e.type === "turn/end").at(-1).data.reason.kind, "error")
    console.log(JSON.stringify({ evidenceScenario: "success", realBrowserBundles: bundles.length, nonBlockingNavigation: true, completionRecovery: true, sourceRefReplay: true, missingContractFailClosed: true, boundedRecovery: true }))
  } finally {
    for (const id of sessions) await ctx.browserRuntime.cleanupSession(id)
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
}
