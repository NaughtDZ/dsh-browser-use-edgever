import assert from "node:assert/strict"
import test from "node:test"
import * as browser from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"

test("access pages are detected specifically, not from ordinary article mentions", () => {
  assert.equal(browser.detectAccessProblem("If you are a reader experiencing an access issue, please contact support@people.inc"), "access_denied")
  assert.equal(browser.detectAccessProblem("Sorry, we just need to make sure you're not a robot. Type the characters you see in this image"), "captcha")
  assert.equal(browser.detectAccessProblem("An article about CAPTCHA and access denied error messages"), null)
  assert.equal(browser.detectAccessProblem("Our systems have detected unusual traffic from your computer network"), "captcha")
  assert.equal(browser.detectAccessProblem("Access Denied. You don't have permission to access this server. Reference #1"), "access_denied")
})

test("access circuit is origin-scoped, network retries bounded, and success resets network failures", () => {
  const guard = new browser.BrowserAccessGuard()
  guard.failed("https://example.com/a", "network")
  assert.doesNotThrow(() => guard.check("https://example.com/b"))
  guard.failed("https://example.com/b", "network")
  assert.throws(() => guard.check("https://example.com/c"), /BROWSER_ACCESS_BLOCKED/)
  assert.doesNotThrow(() => guard.check("https://other.example/"))
  guard.succeeded("https://example.com/a")
  assert.doesNotThrow(() => guard.check("https://example.com/b"))
  guard.failed("https://example.com/", "captcha")
  assert.throws(() => guard.check("https://example.com/other"), /captcha/)
  assert.doesNotThrow(() => new browser.BrowserAccessGuard().check("https://example.com/"))
  assert.doesNotThrow(() => guard.check("about:blank"))
  assert.doesNotThrow(() => guard.check(undefined))
})

test("access counters use host markers, not page instructions, and are turn-scoped", () => {
  const session = Session.create(SessionId("access-test"))
  const append = (turn, isError, text, accessFailure) => session.append("tool/result", {
    turn, step: 1, meta: { browserContext: accessFailure ? { accessFailure } : {} },
    message: createUserMessage({ source: { kind: "tool", callId: "fixture" }, content: [{ type: "tool-result", toolCallId: "fixture", isError, content: [{ type: "text", text }] }] }),
  }, { surfaceOp: "append" })
  append(1, false, "BROWSER_ACCESS_BLOCKED: page content, not a host error")
  assert.equal(browser.accessFailureCount(session, 1), 0)
  append(1, true, "Error: BROWSER_ACCESS_BLOCKED: network")
  append(1, false, "page", "captcha")
  assert.equal(browser.accessFailureCount(session, 1), 2)
  assert.equal(browser.accessFailureCount(session, 2), 0)
})
