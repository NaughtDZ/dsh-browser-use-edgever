/**
 * Accessibility Data Fetching
 *
 * Accessibility.getFullAXTree is the most expensive single CDP call in an
 * extraction (~1.1s / 7MB on a large page) and its cost scales with the number
 * of nodes returned. Almost none of it is used: the HTML pipeline reads an AX
 * node only through getAllTextTillNextCandidate's name fallback, which fires
 * exclusively on candidates and structural visual elements (table cells) —
 * tens of nodes out of tens of thousands.
 *
 * So the AX data is fetched per node instead, after computeRenderInfo has
 * decided which nodes qualify.
 *
 * Markdown observation explicitly requests full AX data and skips this partial fetch.
 */

import type { CDPClient } from '../../cdp/client.js';
import type { OOPIFManager } from '../../cdp/oopif-manager.js';
import type { Accessibility } from '../types/cdp.js';
import { buildEnhancedAXNode } from '../types/ax.js';
import type { EnhancedDOMTreeNode } from '../types/dom-node.js';
import { isVisualTopNode, STRUCTURAL_CHILD_TAGS } from '../utils/index.js';

/**
 * Nodes whose accessible name the pipeline can actually consult.
 *
 * - candidates reach it through hasContent() during pruning;
 * - visual elements reach it through the serializer, which asks for their text;
 * - structural children (table cells and friends) reach it the same way, but
 *   only matter when they wrap a candidate — that is exactly the case where
 *   local text extraction comes back empty, because the walk stops at the
 *   nested candidate and the cell's text lives inside it. They qualify even
 *   when off-screen, since the serializer still renders the expanded zone.
 *
 * The root is included so the page title stays available.
 */
function collectNodesNeedingAx(
  root: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode[] {
  const nodes: EnhancedDOMTreeNode[] = [root];

  // Bottom-up so a parent sees its subtree's answer without re-walking it
  const visit = (node: EnhancedDOMTreeNode): boolean => {
    let subtreeHasCandidate = !!node.renderInfo?.isCandidate;
    for (const child of node.childrenNodes ?? []) {
      if (visit(child)) subtreeHasCandidate = true;
    }
    for (const shadow of node.shadowRoots ?? []) {
      if (visit(shadow)) subtreeHasCandidate = true;
    }
    if (node.contentDocument && visit(node.contentDocument)) {
      subtreeHasCandidate = true;
    }

    const needed =
      node.renderInfo?.isCandidate ||
      isVisualTopNode(node) ||
      (STRUCTURAL_CHILD_TAGS.has(node.nodeName.toLowerCase()) &&
        subtreeHasCandidate);
    if (needed && node !== root) nodes.push(node);

    return subtreeHasCandidate;
  };

  visit(root);
  return nodes;
}

/**
 * Attach AX data to the nodes that can use it (assumes CDP is attached and
 * computeRenderInfo has run).
 */
export async function fetchAxForUsedNodes(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const nodes = collectNodesNeedingAx(root);
  if (nodes.length === 0) return;

  await Promise.all(
    nodes.map(async node => {
      const sendCmd =
        node.oopifSessionId && oopifManager
          ? <T>(method: string, params?: Record<string, unknown>) =>
              oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
          : <T>(method: string, params?: Record<string, unknown>) =>
              cdpClient.sendCommand<T>(method, params);

      const result = await sendCmd<{ nodes: Accessibility.AXNode[] }>(
        'Accessibility.getPartialAXTree',
        { backendNodeId: node.backendNodeId, fetchRelatives: false },
      ).catch(() => undefined);

      // fetchRelatives:false still returns ignored ancestors on some pages —
      // take the entry that actually describes this node.
      const axNode = result?.nodes?.find(
        n => n.backendDOMNodeId === node.backendNodeId,
      );
      if (axNode) node.axNode = buildEnhancedAXNode(axNode);
    }),
  );
}
