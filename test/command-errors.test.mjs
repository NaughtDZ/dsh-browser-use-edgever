import test from "node:test"
import assert from "node:assert/strict"
import { DomService } from "../lib/diagnostics.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { browserObservationId, recallEvidence, resolveSourceRef } from "../lib/index.js"

test("page script failures retain the exception type and message", async () => {
  const service = Object.create(DomService.prototype)
  service.client = { sendCommand: async () => ({
    result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "SyntaxError: Invalid regular expression flags" } },
  }) }
  await assert.rejects(service.evaluateWithReturn("invalid"), /SyntaxError: Invalid regular expression flags/)
})

function savedText(text) {
  const session = Session.create(SessionId("command-error-evidence"))
  const observation = { version: 1, runtimeId: "test", tabId: "tab0", domId: "dom0", mode: "full", output: text, fullOutput: text, url: "https://example.test", capturedAt: "2026-09-14T00:00:00Z" }
  session.append("tool/call", { turn: 1, step: 1, callId: "read", name: "browser_observe", arguments: "{}" })
  session.append("tool/result", { turn: 1, step: 1, meta: { browserContext: { version: 1, observation } }, message: createUserMessage({ source: { kind: "tool", callId: "read" }, content: [{ type: "tool-result", toolCallId: "read", content: [{ type: "text", text }] }] }) }, { surfaceOp: "append" })
  return { session, observationId: browserObservationId(observation) }
}

test("exact observation search returns host-issued UTF-16 text references", () => {
  const { session, observationId } = savedText("😀[43490]<a>算法实习</a> and 算法实习")
  const result = recallEvidence(session, { observationId, query: "算法实习" })
  assert.deepEqual(result.sourceSpans.map(s => s.sourceRef.start), [12, 25])
  for (const span of result.sourceSpans) assert.equal(resolveSourceRef(session, span.sourceRef).value, "算法实习")
  assert.equal(result.nextMatchOffset, null)
  assert.deepEqual(recallEvidence(session, { observationId, query: "absent" }).sourceSpans, [])
  assert.throws(() => recallEvidence(session, { observationId, query: "" }), /query/)
  assert.throws(() => resolveSourceRef(session, { observationId, start: 43490, end: 43491 }), /browser_recall/)
  assert.throws(() => resolveSourceRef(session, { observationId, start: 0, end: 0 }), /browser_recall/)
  assert.throws(() => resolveSourceRef(session, { observationId, recordId: "invented", field: "", start: 1 }), /not both/)
})

test("exact text search paginates repeated matches without inventing references", () => {
  const { session, observationId } = savedText("job ".repeat(12))
  const first = recallEvidence(session, { observationId, query: "job" })
  assert.equal(first.sourceSpans.length, 10)
  const last = recallEvidence(session, { observationId, query: "job", offset: first.nextMatchOffset })
  assert.equal(last.sourceSpans.length, 2)
  assert.equal(last.nextMatchOffset, null)
})
