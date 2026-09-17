import { getPageDom } from "../dom-utils.js"
import { operationError, throwIfBrowserAborted, type BrowserOperation } from "../runtime.js"

export const browserViewElements: BrowserOperation = {
  id: "browser_view_elements",
  description: "Capture visual evidence for [view:ID] elements from the current DOM snapshot and attach the resulting images to DSH.",
  async execute(args, context) {
    const viewIds = Array.isArray(args.viewIds) ? args.viewIds.map(String) : []
    if (viewIds.length === 0) return operationError("View elements", "missing_view_ids", "No viewIds provided.")
    return context.manager.enqueue(async () => {
      const tab = context.manager.getActiveTab()
      const { domService } = tab
      const visualElementMap = domService.getLatestVisualElementMap()
      if (!visualElementMap || visualElementMap.size === 0) {
        return operationError("View elements", "visual_elements_unavailable", "No visual elements available. Wait for the page and refresh the DOM snapshot.")
      }
      return domService.withClient(async () => {
        const textParts: string[] = []
        const attachments: Array<{ mime: "image/jpeg"; filename: string; dataUrl: string }> = []
        for (const id of viewIds) {
          throwIfBrowserAborted(context.signal)
          const node = visualElementMap.get(id)
          if (!node) {
            textParts.push(`Visual element view:${id} not found in current DOM.`)
            continue
          }
          const rect = await domService.getElementRect(node)
          const padding = 10
          const base64 = await domService.captureClip({
            x: Math.max(0, rect.x - padding),
            y: Math.max(0, rect.y - padding),
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          })
          textParts.push(`view:${id} <${node.nodeName.toLowerCase()}>: [see attachment]`)
          attachments.push({ mime: "image/jpeg", filename: `view-${id}.jpg`, dataUrl: `data:image/jpeg;base64,${base64}` })
        }
        return {
          status: attachments.length === viewIds.length ? "success" : attachments.length > 0 ? "partial" : "error",
          title: `View ${viewIds.length} element(s)`, output: textParts.join("\n"), metadata: {}, attachments,
          ...(tab.lastDomId ? { imageState: { runtimeId: context.manager.runtimeId, domId: tab.lastDomId, tabId: tab.id } } : {}),
        }
      })
    }, context.signal)
  },
}

/** Explicit observation always establishes a full baseline, without reloading the page. */
export const browserObserve: BrowserOperation = {
  id: "browser_observe",
  description: "Read a fresh full DOM snapshot without navigating or reloading. Use after manual page changes or stale references. format: markdown provides semantic text with the same element markers.",
  async execute(args, context) {
    return context.manager.enqueue(async () => {
      throwIfBrowserAborted(context.signal)
      const dom = await getPageDom(context.manager, undefined, { forceFull: true, format: args.format === "markdown" ? "markdown" : "html" })
      return { title: "Observe current page", output: dom.output, observation: dom.observation, metadata: { domId: dom.domId, format: args.format ?? "html" } }
    }, context.signal)
  },
}
