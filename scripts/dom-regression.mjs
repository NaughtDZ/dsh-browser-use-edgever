import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { BrowserRuntime } from "../lib/index.js"
import { CDPTape, captureDomTape, replayDomTape } from "../lib/diagnostics.js"

const [command, directory, url] = process.argv.slice(2)
if (!["capture", "verify"].includes(command) || !directory || (command === "capture" && !url)) {
  throw new Error("Usage: npm run dom:regression -- capture <output-directory> <url> | verify <output-directory>. Capture stores page/CDP data locally; use controlled fixtures and keep recordings out of Git.")
}
const tapePath = path.resolve(directory, "cdp.json.gz")
const goldenPath = path.resolve(directory, "golden.json")
if (command === "capture") {
  await mkdir(directory, { recursive: true })
  const runtime = new BrowserRuntime({ headless: true, noSandbox: false, viewport: { width: 1280, height: 900 }, maxContextDeltas: 8 })
  try {
    const tab = await runtime.getManager("regression").newTab(url)
    const { tape, result, stats } = await captureDomTape(tab.page)
    tape.save(tapePath)
    await writeFile(goldenPath, JSON.stringify({ html: result.html, elementIds: result.elementIds }, null, 2))
    console.log(JSON.stringify({ captured: tape.size, stagesMs: result.stagesMs, cdp: stats }, null, 2))
  } finally { await runtime.dispose() }
} else {
  const golden = JSON.parse(await readFile(goldenPath, "utf8"))
  const result = await replayDomTape(CDPTape.load(tapePath))
  assert.equal(result.html, golden.html, "DOM output differs from recorded baseline")
  assert.deepEqual(result.elementIds, golden.elementIds, "Action references differ from baseline")
  console.log(JSON.stringify({ verified: true, stagesMs: result.stagesMs }))
}
