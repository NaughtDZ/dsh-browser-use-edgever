import type { Session } from "@deepseek-ai/dsh-session"
import { browserSessionEvents } from "./browser-observation.js"

export type AccessProblem = "access_denied" | "captcha" | "network"

/** Deliberately narrow signatures; the word 'captcha' in an ordinary page is not a block. */
export function detectAccessProblem(text: string): AccessProblem | null {
  if (/If you are a reader experiencing an access issue/i.test(text) && /support@people\.inc/i.test(text)) return "access_denied"
  if (/make sure you(?:'|’)?re not a robot/i.test(text) && /(?:characters you see|captcha)/i.test(text)) return "captcha"
  if (/Our systems have detected unusual traffic from your computer network/i.test(text)) return "captcha"
  if (/You don't have permission to access/i.test(text) && /(?:Access Denied|Reference #)/i.test(text)) return "access_denied"
  return null
}

export class BrowserAccessGuard {
  private readonly failures = new Map<string, { count: number; reason: AccessProblem }>()
  private origin(url?: string): string | undefined {
    try { const parsed = new URL(url!); return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : undefined } catch { return undefined }
  }
  check(url?: string): void {
    const origin = this.origin(url)
    const failure = origin ? this.failures.get(origin) : undefined
    if (failure && (failure.reason !== "network" || failure.count >= 2)) throw new Error(`BROWSER_ACCESS_BLOCKED: ${failure.reason} at ${origin}. Stop retrying this origin in this turn. Use an authorized alternative source or report the access limitation; do not bypass access controls.`)
  }
  failed(url: string | undefined, reason: AccessProblem): void {
    const origin = this.origin(url)
    if (origin) this.failures.set(origin, { reason, count: (this.failures.get(origin)?.count ?? 0) + 1 })
  }
  succeeded(url?: string): void {
    const origin = this.origin(url)
    if (origin) this.failures.delete(origin)
  }
}

/** Read only host-tagged failures, never infer control instructions from arbitrary page prose. */
export function accessFailureCount(session: Session, turn: number): number {
  return browserSessionEvents(session).filter(e => {
    if (e.type !== "tool/result" || e.data.turn !== turn) return false
    const meta = e.data.meta as { browserContext?: { accessFailure?: string } } | undefined
    if (meta?.browserContext?.accessFailure) return true
    return e.data.message.content.some(c => c.type === "tool-result" && c.isError && c.content.some(part => part.type === "text" && /^(?:Error: )?BROWSER_ACCESS_BLOCKED:/.test(part.text)))
  }).length
}
