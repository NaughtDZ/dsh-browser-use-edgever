import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { apply } from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"

const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(`<!doctype html><title>Command error regression</title>
    <style>#close{width:60px;height:60px;position:relative}#close::before{content:'×';position:absolute;inset:0;background:#ddd;display:grid;place-items:center}</style>
    <button id="close" aria-label="Close" onclick="document.querySelector('#result').textContent='Closed'">Close</button>
    <button id="plain" onclick="document.querySelector('#result').textContent='Plain clicked'">Plain</button>
    <div id="result">Ready</div>`)
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const registered = []
const context = {
  provide(name, value) { this[name] = value; return () => { delete this[name] } },
  tools: { register(tool) { registered.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } }, on() { return () => {} }, get() {}, logger: { warn() {} },
}
const dispose = apply(context, { approvalMode: "off", headless: true })
const session = Session.create(SessionId("command-error-smoke"))
let seq = 0
async function call(name, args = {}) {
  const callId = `command-${++seq}`
  return registered.find(t => t.name === name).execute(args, {
    callId, rootCallId: callId, name, arguments: args, agent: { id: String(session.id), session },
    signal: AbortSignal.timeout(30000), token: Symbol(), deferContext() {}, concludeTurn() {},
  })
}
try {
  await call("browser_start", { url: `http://127.0.0.1:${server.address().port}/` })
  const tab = context.browserRuntime.getManager(String(session.id)).getActiveTab()
  const indexFor = id => [...tab.domService.getLatestSelectorMap()].find(([, n]) => n.attributes?.id === id)?.[0]
  assert.ok(indexFor("close"), "pseudo-element button must have a DOM marker")
  const clicked = await call("browser_click", { elementIndex: indexFor("close"), expectText: "Closed" })
  assert.equal(clicked.status, "success", clicked.output)
  assert.equal(await tab.page.$eval("#result", el => el.textContent), "Closed")
  const trailingComment = await call("browser_execute_script", { script: "return { count: 15 }; // trailing extraction note" })
  assert.equal(trailingComment.status, "success")
  assert.match(trailingComment.output, /"count":15/)
  await assert.rejects(call("browser_execute_script", { script: "return /foo/invalid;" }), error => {
    assert.match(error.message, /SyntaxError/)
    assert.match(error.message, /Correct the script/)
    return true
  })
  await assert.rejects(call("browser_execute_script", { script: "throw new TypeError('fixture detail');" }), /TypeError: fixture detail/)
  const plainIndex = indexFor("plain")
  await tab.page.evaluate(() => {
    const rect = document.querySelector("#plain").getBoundingClientRect()
    const overlay = document.createElement("div")
    overlay.id = "overlay"
    Object.assign(overlay.style, { position: "fixed", left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px", zIndex: "99999", background: "red" })
    document.body.append(overlay)
  })
  const blocked = await call("browser_click", { elementIndex: plainIndex })
  assert.equal(blocked.status, "error")
  assert.equal(blocked.metadata.errorCode, "element_occluded")
  assert.equal(await tab.page.$eval("#result", el => el.textContent), "Closed", "real overlays must not be bypassed")
  await tab.page.$eval("#overlay", el => el.remove())
  await call("browser_observe")
  const removedIndex = indexFor("plain")
  await tab.page.$eval("#plain", el => el.remove())
  await call("browser_observe")
  const missing = await call("browser_click", { elementIndex: removedIndex })
  assert.equal(missing.status, "error")
  assert.match(missing.output, /browser_observe/)
  console.log(JSON.stringify({ status: "success", pseudoElementClick: true, realOverlayBlocked: true, staleMarkerRejected: true, trailingCommentScript: true, detailedScriptErrors: true }))
} finally {
  await dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
