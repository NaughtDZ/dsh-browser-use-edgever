// Resolution of the local browser executable: Chrome, Chromium, and Microsoft Edge across platforms.
// Every case injects platform/environment/existence so the suite needs no installed browser.
import test from "node:test"
import assert from "node:assert/strict"
import { resolveBrowserExecutable } from "../lib/index.js"

const EDGE_WIN = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const EDGE_WIN_64 = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
const CHROME_WIN = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const CHROMIUM_WIN = "C:\\Program Files\\Chromium\\Application\\chrome.exe"
const EDGE_MAC = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const EDGE_LINUX = "/usr/bin/microsoft-edge"

/** Existence probe limited to the listed paths. */
const files = (...paths) => {
  const set = new Set(paths)
  return path => set.has(path)
}

test("an explicit path wins over channel and environment overrides", () => {
  assert.equal(resolveBrowserExecutable({
    executablePath: "  D:\\custom\\msedge.exe  ",
    channel: "chrome",
    platform: "win32",
    env: { CHROME_PATH: CHROME_WIN, EDGE_PATH: EDGE_WIN },
    exists: () => true,
  }), "D:\\custom\\msedge.exe")
})

test("auto reaches Edge on a Windows machine without Chrome", () => {
  assert.equal(resolveBrowserExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    exists: files(EDGE_WIN),
  }), EDGE_WIN)
})

test("auto keeps Chrome first when both families are installed", () => {
  assert.equal(resolveBrowserExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    exists: files(CHROME_WIN, EDGE_WIN),
  }), CHROME_WIN)
})

test("channel edge ignores an installed Chrome", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "edge",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    exists: files(CHROME_WIN, EDGE_WIN),
  }), EDGE_WIN)
})

test("channel edge finds the 64-bit Program Files install location", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "edge",
    platform: "win32",
    env: {},
    exists: files(EDGE_WIN_64),
  }), EDGE_WIN_64)
})

test("channel chrome ignores an Edge-only machine", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "chrome",
    platform: "win32",
    env: {},
    exists: files(EDGE_WIN),
  }), "chrome")
})

test("channel chromium only probes Chromium", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "chromium",
    platform: "win32",
    env: {},
    exists: files(CHROME_WIN, EDGE_WIN, CHROMIUM_WIN),
  }), CHROMIUM_WIN)
})

test("a browser-specific variable is ignored by another channel", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "edge",
    platform: "win32",
    env: { CHROME_PATH: CHROME_WIN },
    exists: files(CHROME_WIN),
  }), "msedge")
})

test("brand variables override installed locations", () => {
  assert.equal(resolveBrowserExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", EDGE_PATH: "D:\\Edge\\msedge.exe" },
    exists: files("D:\\Edge\\msedge.exe", EDGE_WIN),
  }), "D:\\Edge\\msedge.exe")
})

test("BROWSER_PATH overrides every channel", () => {
  assert.equal(resolveBrowserExecutable({
    channel: "chrome",
    platform: "win32",
    env: { BROWSER_PATH: EDGE_WIN, CHROME_PATH: CHROME_WIN },
    exists: files(EDGE_WIN, CHROME_WIN),
  }), EDGE_WIN)
})

test("a missing LOCALAPPDATA never yields an undefined path", () => {
  const seen = []
  const path = resolveBrowserExecutable({
    platform: "win32",
    env: {},
    exists: candidate => { seen.push(candidate); return false },
  })
  assert.equal(path, "chrome")
  assert.equal(seen.some(candidate => candidate.includes("undefined")), false)
})

test("macOS probes Edge instead of assuming Chrome exists", () => {
  assert.equal(resolveBrowserExecutable({
    platform: "darwin",
    env: {},
    exists: files(EDGE_MAC),
  }), EDGE_MAC)
  assert.equal(resolveBrowserExecutable({
    channel: "edge",
    platform: "darwin",
    env: { HOME: "/Users/tester" },
    exists: files("/Users/tester/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
  }), "/Users/tester/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  assert.equal(resolveBrowserExecutable({
    platform: "darwin",
    env: {},
    exists: files(CHROME_MAC),
  }), CHROME_MAC)
})

test("Linux probes the Microsoft Edge packages", () => {
  assert.equal(resolveBrowserExecutable({
    platform: "linux",
    env: {},
    exists: files(EDGE_LINUX),
  }), EDGE_LINUX)
  assert.equal(resolveBrowserExecutable({
    channel: "edge",
    platform: "linux",
    env: {},
    exists: files("/opt/microsoft/msedge/microsoft-edge"),
  }), "/opt/microsoft/msedge/microsoft-edge")
})

test("no installed browser falls back to a PATH command name per channel", () => {
  const probe = () => false
  assert.equal(resolveBrowserExecutable({ platform: "win32", env: {}, exists: probe }), "chrome")
  assert.equal(resolveBrowserExecutable({ channel: "edge", platform: "win32", env: {}, exists: probe }), "msedge")
  assert.equal(resolveBrowserExecutable({ channel: "edge", platform: "linux", env: {}, exists: probe }), "microsoft-edge")
  assert.equal(resolveBrowserExecutable({ platform: "linux", env: {}, exists: probe }), "google-chrome")
})
