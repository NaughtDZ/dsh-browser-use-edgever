import type { Session } from "@deepseek-ai/dsh-session"
import { getBrowserObservations, recallBrowserMemory } from "./browser-memory.js"
import { evidenceBundles, observationRecords, taskRecords, type SourceRef } from "./browser-evidence.js"

export function recallEvidence(session: Session, input: Record<string, unknown>) {
  const offset = input.offset ?? 0
  const limit = input.limit ?? 20
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer")
  if (input.mode !== undefined && !["facts", "bundles", "records"].includes(String(input.mode))) throw new Error("Unknown recall mode")
  if (input.observationId !== undefined) {
    const result = recallBrowserMemory(session, input)
    const sourceSpans: Array<{ value: string; sourceRef: SourceRef }> = []
    let nextMatchOffset: number | null = null
    if (input.query !== undefined) {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1200) throw new Error("query must be nonempty exact source text of at most 1200 UTF-16 characters")
      const observationId = String(input.observationId)
      const text = getBrowserObservations(session).find(entry => entry.id === observationId)!.observation.fullOutput
      let start = text.indexOf(input.query, offset)
      while (start !== -1 && sourceSpans.length < 10) {
        const end = start + input.query.length
        sourceSpans.push({ value: text.slice(start, end), sourceRef: { observationId, start, end } })
        start = text.indexOf(input.query, end)
      }
      if (start !== -1) nextMatchOffset = start
    }
    const records = observationRecords(session, String(input.observationId))
    const recordOffset = input.recordOffset ?? 0
    if (typeof recordOffset !== "number" || !Number.isSafeInteger(recordOffset) || recordOffset < 0) throw new Error("recordOffset must be a nonnegative integer")
    const sourceRecords = []
    let bytes = 0
    for (const record of records.slice(recordOffset, recordOffset + 10)) {
      const size = JSON.stringify(record).length
      if (sourceRecords.length && bytes + size > 16000) break
      sourceRecords.push(record)
      bytes += size
    }
    return { ...result, ...(input.query !== undefined ? { sourceSpans, nextMatchOffset } : {}), sourceRecords, totalSourceRecords: records.length, nextRecordOffset: recordOffset + sourceRecords.length < records.length ? recordOffset + sourceRecords.length : null,
      sourceIndexScope: "Bounded index: first 100 top-level records, 100 scalar fields per record, depth 8, strings up to 12000 characters. Not proof of complete extraction. Narrow the extraction for omitted fields/records; truncated script results have no structured index." }
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("limit must be an integer between 1 and 30")
  if (input.bundleId !== undefined) {
    const bundle = evidenceBundles(session).find(b => b.id === input.bundleId)
    if (!bundle) throw new Error("Unknown evidence bundle")
    const ids = new Set(bundle.observationIds.slice(offset, offset + limit))
    return { bundle: { ...bundle, observationIds: undefined, observationCount: bundle.observationIds.length }, observations: getBrowserObservations(session).filter(o => ids.has(o.id)).map(o => o.source), nextOffset: offset + limit < bundle.observationIds.length ? offset + limit : null }
  }
  if (input.mode === "bundles" || input.mode === "records") {
    const all = input.mode === "bundles" ? evidenceBundles(session).map(b => ({ ...b, observationIds: undefined, observationCount: b.observationIds.length, latestObservationId: b.observationIds.at(-1) })) : taskRecords(session)
    return { [input.mode]: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null }
  }
  return recallBrowserMemory(session, input)
}
