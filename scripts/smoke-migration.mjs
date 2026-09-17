import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { apply, browserObservationId, recordBrowserFacts, recallBrowserMemory } from "../lib/index.js"
import { CDPTape, CDPStats, captureDomTape, replayDomTape } from "../lib/diagnostics.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"

let port
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  if (req.url === "/frame") return res.end('<!doctype html><title>Child</title><input id="childInput" aria-label="Child input"><button id="childButton" onclick="document.getElementById(\'childResult\').textContent=\'Child clicked\'">Child action</button><p id="childResult">Waiting</p>')
  if (req.url === "/other") return res.end("<!doctype html><title>Other</title><h1>Other page</h1>")
  res.end(`<!doctype html><title>Migration fixture</title><h1>Product catalogue</h1>
  <script type="application/ld+json">{"@type":"Product","name":"Hidden Widget","offers":{"price":"123.45","priceCurrency":"CNY"}}</script>
  <meta property="og:title" content="Catalogue"><div itemscope itemtype="https://schema.org/Book"><span itemprop="name">Fixture book</span></div>
  <ul>${["Alpha", "Beta", "Gamma"].map((name, i) => `<li class="product"><a href="#${name}">${name}</a><span class="price">${10 + i}</span></li>`).join("")}</ul>
  <label>Query <input id="query"></label><button id="mainButton">Main action</button><p id="manual">Initial text</p>
  <iframe title="Cross site" src="http://localhost:${port}/frame" width="700" height="220"></iframe>`)
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
port = server.address().port
const url = `http://127.0.0.1:${port}/`
const tools = []
const context = {
  provide(name, value) { this[name] = value; return () => { delete this[name] } },
  tools: { register(tool) { tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } }, on() { return () => {} }, get() {}, logger: { warn() {} },
}
const dispose = apply(context, { approvalMode: "off", headless: true })
const session = Session.create(SessionId("migration"))
let seq = 0
async function call(name, args = {}) {
  const callId = `migration-${++seq}`
  return tools.find(t => t.name === name).execute(args, {
    callId, rootCallId: callId, name, arguments: args, agent: { id: String(session.id), session },
    signal: new AbortController().signal, token: Symbol(), deferContext() {}, concludeTurn() {},
  })
}
const resultData = result => JSON.parse(result.output.match(/Result: ([^\n]+)/)[1])
const dir = await mkdtemp(path.join(tmpdir(), "dsh-cdp-regression-"))
try {
  const guide = await call("browser_execute_script", { guide: true })
  assert.match(guide.output, /__records/)
  await call("browser_start", { url })
  const manager = context.browserRuntime.getManager(String(session.id))
  const tab = manager.getActiveTab()
  const stats = new CDPStats()
  tab.cdpClient.setStats(stats)
  await tab.page.evaluate(() => { document.querySelector("#manual").textContent = "Manually changed"; document.querySelector("#query").value = "preserved" })
  const observed = await call("browser_observe")
  assert.equal(observed.browserContext.observation.mode, "full")
  assert.match(observed.output, /Manually changed/)
  assert.equal(await tab.page.$eval("#query", el => el.value), "preserved", "observe must not reload")
  assert.ok(stats.rows().some(row => row.method === "Accessibility.getPartialAXTree"))
  assert.ok(!stats.rows().some(row => row.method === "Accessibility.getFullAXTree"))
  const structured = await call("browser_execute_script", { script: 'return __data("Product")' })
  assert.equal(resultData(structured)[0].offers.price, "123.45")
  const microdata = await call("browser_execute_script", { script: 'return __data("Book")' })
  assert.equal(resultData(microdata)[0].name, "Fixture book")
  const meta = await call("browser_execute_script", { script: 'return __data("PageMeta")' })
  assert.equal(resultData(meta)[0]["og:title"], "Catalogue")
  const records = resultData(await call("browser_execute_script", { script: 'var rows = __records(__find("Alpha", "a")[0]); return { count: rows.length, shape: __skeleton(rows[0]), names: rows.map(r => r.querySelector("a").textContent) }' }))
  assert.equal(records.count, 3)
  assert.deepEqual(records.names, ["Alpha", "Beta", "Gamma"])
  assert.match(records.shape, /price/)
  const refs = resultData(await call("browser_execute_script", { script: 'var a = __find("Alpha", "a")[0]; return { ref: a.ref, same: __get(a.ref) === a, clickables: __clickable(a).length }' }))
  assert.equal(refs.same, true)

  // The exact script evidence is retained by the existing Session fact store.
  const observation = structured.browserContext.observation
  session.append("tool/call", { turn: 1, step: 1, callId: "structured-source", name: "browser_execute_script", arguments: "{}" })
  session.append("tool/result", { turn: 1, step: 1, meta: structured, message: createUserMessage({ source: { kind: "tool", callId: "structured-source" }, content: [{ type: "tool-result", toolCallId: "structured-source", content: [{ type: "text", text: structured.output }] }] }) }, { surfaceOp: "append" })
  const evidence = structured.output.match(/Result: ([^\n]+)/)[1]
  recordBrowserFacts(session, { observations: [{ observationId: browserObservationId(observation), facts: [{ entity: "Hidden Widget", attribute: "price", value: "123.45", evidence }] }] })
  assert.match(JSON.stringify(recallBrowserMemory(session, { query: "Hidden Widget" })), /123.45/)

  // Assert a genuine child-process session, child data and concrete child interaction.
  const selectorMap = tab.domService.getLatestSelectorMap()
  const childInput = [...selectorMap].find(([, node]) => node.attributes.id === "childInput")
  const childButton = [...selectorMap].find(([, node]) => node.attributes.id === "childButton")
  assert.ok(childInput?.[1].oopifSessionId, "fixture must produce an OOPIF input")
  assert.ok(childButton?.[1].oopifSessionId, "fixture must produce an OOPIF button")
  const input = await call("browser_input", { elementIndex: childInput[0], text: "child value" })
  assert.equal(input.status, "success", input.output)
  const frame = tab.page.frames().find(f => f.url().includes("/frame"))
  await frame.$eval("#childButton", el => { el.style.marginLeft = "120px" })
  const button = [...tab.domService.getLatestSelectorMap()].find(([, node]) => node.attributes.id === "childButton")
  assert.equal((await call("browser_click", { elementIndex: button[0] })).status, "success")
  assert.equal(await frame.$eval("#childInput", el => el.value), "child value")
  assert.equal(await frame.$eval("#childResult", el => el.textContent), "Child clicked")

  stats.reset()
  const markdown = await call("browser_observe", { format: "markdown" })
  assert.match(markdown.output, /Product catalogue/)
  assert.match(markdown.output, /Action references/)
  assert.match(markdown.output, /Child action/)
  assert.ok(stats.rows().some(row => row.method === "Accessibility.getFullAXTree"))
  const checkpoint = markdown.output.match(/stateId: ([^)]+)/)[1]
  await tab.page.goto(url + "other")
  context.browserRuntime.prepareContext(session)
  assert.match(JSON.stringify(session.deriveMessages()), /Browser URL changed/)
  await assert.rejects(call("browser_click", { elementIndex: button[0] }), error => /browser_observe/.test(`${error.message} ${error.cause?.message}`))
  await call("browser_observe")
  assert.equal(manager.detectStateChanges().length, 0)
  const restored = await call("browser_restore_state", { stateId: checkpoint })
  assert.equal(restored.metadata.restoreMethod, "history")
  // iframe state is explicitly omitted by the checkpoint contract.
  assert.equal(restored.status, "partial")
  assert.equal(await tab.page.$eval("#query", el => el.value), "preserved")

  const { tape, result: golden } = await captureDomTape(tab.page)
  tab.cdpClient.setStats(null)
  const tapePath = path.join(dir, "cdp.gz")
  tape.save(tapePath)
  const replay = await replayDomTape(CDPTape.load(tapePath))
  assert.equal(replay.html, golden.html)
  assert.deepEqual(replay.elementIds, golden.elementIds)
  console.log(JSON.stringify({ observe: true, structuredData: true, repeatingLists: true, evidenceMemory: true, oopifInputAndClick: true, fullAXMarkdown: true, urlNotice: true, historyRestore: true, offlineReplay: true, cdpMethods: stats.rows().length }))
} finally {
  await dispose()
  await new Promise(resolve => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
