/**
 * Module overview
 * Responsibility: Resolve which local Chromium-family executable Puppeteer should launch.
 * Usage: Called by BrowserManager before every first launch; explicit configuration wins over environment overrides, which win over installed-browser probing.
 * State and failure boundaries: File-system probing only. It never spawns a process and never throws for a missing browser, so a bad configuration still surfaces as a Puppeteer launch error.
 * Maintenance: puppeteer-core maps only Chrome release channels (no `msedge`), so Edge must be resolved here. Mirror every candidate list in test/browser-executable.test.mjs.
 */

import { existsSync } from "node:fs"

/**
 * Browser families this plugin can launch.
 *
 * `auto` probes Chrome, then Chromium, then Edge, so an Edge-only machine works without configuration.
 * A concrete channel restricts probing to that family, which is how an Edge user keeps Chrome out of the way.
 */
export type BrowserChannel = "auto" | "chrome" | "chromium" | "edge"

export interface BrowserExecutableOptions {
  /** Absolute path from plugin configuration; when set it wins over environment and probing. */
  executablePath?: string
  channel?: BrowserChannel
  /** Injectable platform, environment, and existence probe so tests run without installed browsers. */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

type Brand = Exclude<BrowserChannel, "auto">

/** Probing order for `auto`; Chrome first keeps the upstream behavior for machines that already have Chrome. */
const AUTO_ORDER: readonly Brand[] = ["chrome", "chromium", "edge"]

/** A browser-specific variable is only honored for its own brand so an explicit channel cannot be hijacked. */
const ENV_KEYS: Record<Brand, readonly string[]> = {
  chrome: ["CHROME_PATH"],
  chromium: [],
  edge: ["EDGE_PATH"],
}

/** Brand-neutral override, honored for every channel. */
const GENERIC_ENV_KEYS: readonly string[] = ["BROWSER_PATH"]

function windowsCandidates(brand: Brand, env: NodeJS.ProcessEnv): string[] {
  const localAppData = env.LOCALAPPDATA
  switch (brand) {
    case "chrome":
      return [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      ]
    case "chromium":
      return [
        ...(localAppData ? [`${localAppData}\\Chromium\\Application\\chrome.exe`] : []),
        "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      ]
    case "edge":
      // Microsoft's installer places Edge in the 32-bit Program Files path on both x86 and x64 Windows.
      return [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ...(localAppData ? [`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`] : []),
      ]
  }
}

function macCandidates(brand: Brand, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME
  switch (brand) {
    case "chrome":
      return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    case "chromium":
      return ["/Applications/Chromium.app/Contents/MacOS/Chromium"]
    case "edge":
      return [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ...(home ? [`${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`] : []),
      ]
  }
}

function linuxCandidates(brand: Brand): string[] {
  switch (brand) {
    case "chrome":
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
    case "chromium":
      return ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"]
    case "edge":
      return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/microsoft-edge"]
  }
}

function systemCandidates(brand: Brand, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") return windowsCandidates(brand, env)
  if (platform === "darwin") return macCandidates(brand, env)
  return linuxCandidates(brand)
}

/** Command name handed to Puppeteer for PATH lookup when nothing is installed; the launch then fails with a spawn error. */
function fallbackCommand(channel: BrowserChannel, platform: NodeJS.Platform): string {
  const edge = channel === "edge"
  if (platform === "win32") return edge ? "msedge" : "chrome"
  return edge ? "microsoft-edge" : "google-chrome"
}

/** Resolve the executable path for the configured channel, or a PATH command name when no candidate exists. */
export function resolveBrowserExecutable(options: BrowserExecutableOptions = {}): string {
  const explicit = options.executablePath?.trim()
  if (explicit) return explicit

  const channel = options.channel ?? "auto"
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const order: readonly Brand[] = channel === "auto" ? AUTO_ORDER : [channel]

  const overrides = [
    ...GENERIC_ENV_KEYS.map(key => env[key]),
    ...order.flatMap(brand => ENV_KEYS[brand].map(key => env[key])),
  ]
  for (const candidate of overrides) {
    const path = candidate?.trim()
    if (path && exists(path)) return path
  }

  for (const brand of order) {
    for (const candidate of systemCandidates(brand, platform, env)) {
      if (exists(candidate)) return candidate
    }
  }

  return fallbackCommand(channel, platform)
}
