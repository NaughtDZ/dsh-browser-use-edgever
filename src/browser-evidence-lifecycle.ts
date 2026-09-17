import type { Context } from "@deepseek-ai/cordis"
import { createUserMessage, type Message } from "@deepseek-ai/dsh-llm"
import type { Session } from "@deepseek-ai/dsh-session"
import { browserSessionEvents } from "./browser-observation.js"
import { checkEvidenceCoverage, evidenceSnapshot, evidenceTask, EVIDENCE_EVENT_SOURCE } from "./browser-evidence.js"
import { BROWSER_TOOL_IDS } from "./tool-schemas.js"
import { accessFailureCount } from "./browser-access.js"

const SNAPSHOT = "dsh-browser:evidence-status"
const GATE = "dsh-browser:completion-gate"

export function prepareEvidenceContext(session: Session, estimate?: (m: Message) => number): void {
  const events = browserSessionEvents(session)
  const price = (seq: number, message: Message) => {
    if (estimate) session.append("compaction/prune", { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: estimate(message) })
  }
  for (const seq of [...session.surface.nodes]) {
    const event = events[seq]
    if (event?.type !== "user/message" || event.surfaceOp !== "append" || event.data.source.kind !== "plugin" || event.data.source.plugin !== EVIDENCE_EVENT_SOURCE) continue
    price(seq, event.data)
    session.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: EVIDENCE_EVENT_SOURCE, form: "notice", summary: "Browser evidence stored" }, content: [{ type: "text", text: "[Browser evidence stored; use browser_recall mode records or browser_check_coverage.]" }] }), { surfaceOp: { op: "replace", start: seq, end: seq }, sourceEventSeqs: [seq] })
  }
  if (!events.some(e => e.type === "tool/call" && (BROWSER_TOOL_IDS as readonly string[]).includes(e.data.name)) && !evidenceTask(session)) return
  const text = evidenceSnapshot(session)
  const previous = session.surface.nodes.map(seq => events[seq]).find(e => e?.type === "user/message" && e.data.source.kind === "plugin" && e.data.source.plugin === SNAPSHOT)
  if (previous?.type === "user/message" && previous.data.content[0]?.type === "text" && previous.data.content[0].text === text) return
  if (previous?.type === "user/message") price(previous.seq, previous.data)
  session.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: SNAPSHOT, form: "snapshot", sections: [{ name: "browser-evidence", text }] }, content: [{ type: "text", text }] }), previous ? { surfaceOp: { op: "replace", start: previous.seq, end: previous.seq }, sourceEventSeqs: [previous.seq] } : { surfaceOp: "append" })
}

/** Stop-boundary hook extends the current turn, never blocks a browser action. */
export function registerEvidenceCompletion(ctx: Context): () => void {
  return ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const session = agent.session
    const events = browserSessionEvents(session)
    const usedBrowser = events.some(e => e.type === "tool/call" && e.data.turn === turn && (BROWSER_TOOL_IDS as readonly string[]).includes(e.data.name))
    if (!usedBrowser && !evidenceTask(session, turn)) return
    const coverage = checkEvidenceCoverage(session, turn)
    if (coverage.status === "complete") return
    if (accessFailureCount(session, turn)) throw new Error("BROWSER_ACCESS_BLOCKED: Required evidence remains unavailable after a website access failure. Task incomplete; do not force evidence recovery from an inaccessible page.")
    const signature = JSON.stringify(coverage.missing)
    const attempts = events.flatMap(e => {
      if (e.type !== "user/message" || e.surfaceOp !== "append" || e.data.source.kind !== "plugin" || e.data.source.plugin !== GATE || e.data.content[0]?.type !== "text") return []
      const data = JSON.parse(e.data.content[0].text)
      return data.turn === turn ? [data] : []
    })
    let unchanged = 0
    for (const attempt of [...attempts].reverse()) {
      if (attempt.signature !== signature) break
      unchanged++
    }
    // A provider that ignores recovery must fail visibly, never be silently marked complete.
    if (unchanged >= 3 || attempts.length >= 8) throw new Error(`Browser evidence remains incomplete after recovery attempts. Missing: ${signature}. The task was not completed.`)
    agent.inject(createUserMessage({ source: { kind: "plugin", plugin: GATE, form: "notice", summary: "Browser completion requires evidence" }, content: [{ type: "text", text: JSON.stringify({ turn, signature, coverage: { ...coverage, missing: coverage.missing.slice(0, 30) }, instruction: "Completion is not accepted. Use browser_define_task if missing; otherwise recall/extract and record the missing fields, then check coverage. Continue browsing freely. Do not weaken the task or claim completion while evidence is missing." }) }] }))
  })
}
