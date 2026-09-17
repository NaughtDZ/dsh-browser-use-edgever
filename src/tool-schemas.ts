import type { ParameterSchemaSpec, ValueSchemaSpec } from "@deepseek-ai/dsh-tools"

export const BROWSER_TOOL_IDS = [
  "browser_start",
  "browser_goto",
  "browser_refresh",
  "browser_restore_state",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_click",
  "browser_input",
  "browser_reveal_offscreen",
  "browser_scroll_next_screen",
  "browser_scroll_to_page",
  "browser_execute_script",
  "browser_observe",
  "browser_view_elements",
  "browser_wait",
] as const

export const MEMORY_TOOL_IDS = ["browser_record_facts", "browser_recall", "browser_define_task", "browser_check_coverage"] as const
export const TOOL_IDS = [...BROWSER_TOOL_IDS, ...MEMORY_TOOL_IDS] as const

export type BrowserToolId = (typeof TOOL_IDS)[number]

export const PARAMETER_SCHEMAS: Record<BrowserToolId, ParameterSchemaSpec> = {
  browser_define_task: {
    mode: { type: "string", required: true, enum: ["records", "interaction"], description: "records for extraction/comparison/research; interaction only for navigation or UI tasks with no record deliverable. Fixed for this user turn." },
    objective: { type: "string", required: true, description: "Faithful description of this user turn's requested deliverable." },
    requiredFields: { type: "array", items: { type: "string" }, description: "Required output field names for EVERY record, e.g. title,company,publishedAt,location. Required and non-empty for records mode. Cannot be weakened in this turn." },
    minRecords: { type: "integer", description: "Minimum records required by the task, at least 1 for records mode. Field coverage does not prove exhaustive search." },
  },
  browser_check_coverage: {},
  browser_start: {
    url: { type: "string", required: true, description: "URL to open in Chromium." },
  },
  browser_goto: {
    url: { type: "string", required: true, description: "URL to navigate the active tab to." },
  },
  browser_refresh: {},
  browser_restore_state: {
    stateId: { type: "string", required: true, description: "Exact checkpoint state ID, including its subversion when present, such as tab0-dom3.2." },
  },
  browser_new_tab: {
    url: { type: "string", description: "Optional URL to open in the new tab." },
  },
  browser_switch_tab: {
    tabId: { type: "string", required: true, description: "Tab ID to activate, e.g. tab1 from [tab:tab1]. The displayed tab:tab1 and [tab:tab1] forms are also accepted." },
  },
  browser_close_tab: {
    tabIds: { type: "array", items: { type: "string" }, description: "Tab IDs to close, e.g. tab1 (also accepts tab:tab1 or [tab:tab1]); omit for the active tab." },
  },
  browser_click: {
    elementIndex: { type: "integer", required: true, description: "Numeric [N] or <N> element marker from the current DOM snapshot." },
    expectText: { type: "string", description: "Optional visible text required after the click; checked for up to 5 seconds." },
    expectUrl: { type: "string", description: "Optional exact final URL required after the click; checked for up to 5 seconds." },
  },
  browser_input: {
    elementIndex: { type: "integer", required: true, description: "Numeric <N> input marker from the current DOM snapshot." },
    text: { type: "string", required: true, description: "Text or value to enter." },
    clear: { type: "boolean", description: "Clear the existing value first; defaults to true." },
    pressEnter: { type: "boolean", description: "Press Enter after input; defaults to false." },
    expectText: { type: "string", description: "Optional visible text required after input; checked for up to 5 seconds." },
    expectUrl: { type: "string", description: "Optional exact final URL required after input; checked for up to 5 seconds." },
  },
  browser_reveal_offscreen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction of the OFF-SCREEN block." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
    target: { type: "string", description: "Optional element/text copied from the OFF-SCREEN block." },
  },
  browser_scroll_next_screen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction to explore." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_scroll_to_page: {
    page: { type: "number", required: true, description: "Target P page position from the scroll map." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_execute_script: {
    script: { type: "string", description: "JavaScript function body executed in the active page; omit to load the guide only." },
    guide: { type: "boolean", description: "Load the extraction guide for structured data and repeating lists." },
  },
  browser_observe: {
    format: { type: "string", enum: ["html", "markdown"], description: "Snapshot representation; defaults to html. Markdown fetches the full accessibility tree." },
  },
  browser_view_elements: {
    viewIds: { type: "array", required: true, items: { type: "string" }, description: "View IDs from [view:ID] markers." },
  },
  browser_wait: {
    seconds: { type: "number", required: true, description: "Seconds to wait before continuing." },
  },
  browser_record_facts: {
    records: { type: "array", description: "Save or merge task records using host-resolved field references. Use the same recordId when supplementing fields; all registered records are checked at completion.", items: { type: "object", additionalProperties: false, properties: {
      recordId: { type: "string", required: true, description: "Stable business record identity, e.g. job URL or vendor/product ID. Do not combine unrelated entities." },
      fields: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
        name: { type: "string", required: true, description: "Task output field name matching requiredFields." },
        sourceRef: { type: "object", required: true, additionalProperties: false, properties: {
          observationId: { type: "string", required: true },
          query: { type: "string", description: "Alternative to offsets or recordId+field: unique exact text (1-1200 characters) already seen in this observation. Host resolves and stores a canonical span. Include entity context if repeated; do not paraphrase. This avoids a separate recall for every field." },
          recordId: { type: "string", description: "Source recordId returned by browser_recall. Pair with field." },
          field: { type: "string", description: "Exact JSON pointer from browser_recall sourceRecords, including empty string for a scalar." },
          start: { type: "integer", description: "Alternative: absolute UTF-16 start offset, NOT a DOM [N] marker. Copy sourceSpans[].sourceRef from browser_recall with observationId and exact-text query; do not guess offsets." },
          end: { type: "integer", description: "Alternative: exclusive end character offset. Use a span OR recordId+field." },
        } },
      } } },
    } } },
    observations: { type: "array", description: "Legacy exact-quote memory only; does not satisfy task-record coverage. Supply observations OR records; use browser_recall for queries.", items: {
      type: "object", additionalProperties: false, properties: {
        observationId: { type: "string", required: true, description: "obs-... ID from browser task memory or browser_recall. Source URL/time is resolved by the host." },
        facts: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          entity: { type: "string", required: true, description: "Exact entity wording present in the evidence quote." },
          attribute: { type: "string", required: true, description: "Stable field name, e.g. price. Reuse for updates." },
          value: { type: "string", required: true, description: "Exact value including currency/unit as shown in the evidence; do not invent conversions." },
          evidence: { type: "string", required: true, description: "One contiguous exact quote from browser_recall observation.content containing both entity and value (at most 1200 characters). Preserve intervening DOM markup; whitespace may be normalized. Do not paraphrase or concatenate separate snippets. Example source Product A: 100 yuan -> entity Product A, value 100 yuan, evidence Product A: 100 yuan." },
        } } },
        reason: { type: "string", description: "Required if facts is empty: why this observation contains no information needed for the user's task (e.g. an unrelated login page). Use facts: [] in that case. A reason never bypasses validation of non-empty facts." },
      },
    } },
  },
  browser_recall: {
    mode: { type: "string", enum: ["facts", "bundles", "records"], description: "Default facts for legacy memory; bundles lists visit groups; records lists this turn's source-backed task records. observationId takes precedence and returns sourceRecords." },
    bundleId: { type: "string", description: "Read one bundle's paginated observation sources." },
    recordOffset: { type: "integer", description: "With observationId, zero-based source-record index; separate from text character offset." },
    query: { type: "string", description: "With observationId: exact case-sensitive source text (1-1200 UTF-16 characters); returns up to 10 sourceSpans with host-issued sourceRefs. Pass nextMatchOffset as offset to continue; inspect context for repeated text. Otherwise case-insensitive search over legacy facts." },
    includeHistory: { type: "boolean", description: "Include earlier observed values as well as current per-source values." },
    observationId: { type: "string", description: "Read an archived observation instead of facts; usable after navigation, compaction or browser restart." },
    offset: { type: "integer", description: "Zero-based record offset for facts/unreviewed sources, or character offset when reading an observation." },
    limit: { type: "integer", description: "For facts/unreviewed sources: records per page, 1-30 (default 20). With observationId: characters to return, 1-12000 (default 12000)." },
  },
}

export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", required: true, enum: ["success", "error", "partial"] },
    summary: { type: "string", required: true },
    output: { type: "string", required: true },
    next_actions: { type: "array", required: true, items: { type: "string" } },
    artifacts: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
          media_type: { type: "string", required: true },
        },
      },
    },
    metadata: { type: "json", required: true },
    browserContext: { type: "json" },
    images: { type: "array", required: true, items: { type: "json" } },
  },
} as const satisfies ValueSchemaSpec
