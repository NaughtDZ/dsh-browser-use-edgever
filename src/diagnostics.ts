/** Explicit, opt-in local diagnostics. Browser tools never record CDP traffic by default. */
import { EventEmitter } from "node:events"
import type { CDPSession, Page } from "puppeteer-core"
import { CDPClient } from "./browser/cdp/client.js"
import { CDPTape } from "./browser/cdp/tape.js"
import { CDPStats } from "./browser/cdp/stats.js"
import { DomService } from "./browser/dom/service.js"

export { CDPClient, CDPTape, CDPStats, DomService }
export { CDPTapeMiss } from "./browser/cdp/tape.js"
export { PageSettleMonitor } from "./browser/dom/settle-monitor.js"

/** Capture an isolated pipeline baseline, excluding the live Agent's interaction history. */
export async function captureDomTape(page: Page, fullAX = false) {
  const client = new CDPClient(await page.createCDPSession())
  const tape = new CDPTape()
  tape.url = page.url()
  tape.capturedAt = new Date().toISOString()
  const stats = new CDPStats()
  client.setTape(tape, "record")
  client.setStats(stats)
  const service = new DomService(page, client)
  try {
    const result = await runDomPipeline(service, fullAX)
    return { tape, result, stats: stats.rows() }
  } finally {
    client.setTape(null)
    client.setStats(null)
    await service.destroySettle()
  }
}

/** Uses the same extraction/rendering methods as getPageDom, with live stage timings. */
export async function runDomPipeline(service: DomService, fullAX = false) {
  const start = performance.now()
  await service.cleanupHighlightsBeforeSnapshot()
  const root = await service.extractCurrentDomTree({ expand: 0.8, fullAX })
  const extracted = performance.now()
  const rendered = await service.renderDomTree(root)
  const finished = performance.now()
  return {
    html: rendered.html,
    elementIds: [...rendered.selectorMap.keys()],
    stagesMs: { extract: extracted - start, render: finished - extracted, total: finished - start },
  }
}

/** A socket-free replay. Any missing request fails verification, even if production code tolerates it. */
export async function replayDomTape(tape: CDPTape, fullAX = false) {
  tape.reset()
  const stub = Object.assign(new EventEmitter(), {
    send: async () => { throw new Error("Offline replay attempted a live CDP call") },
    detach: async () => {},
  }) as unknown as CDPSession
  const client = new CDPClient(stub)
  client.setTape(tape, "replay")
  const service = new DomService({} as Page, client)
  try {
    const result = await runDomPipeline(service, fullAX)
    if (tape.misses().length) throw new Error(`Incomplete CDP tape: ${tape.misses().length} missing requests; first: ${tape.misses()[0]}`)
    return result
  } finally {
    client.setTape(null)
    await service.destroySettle()
  }
}
