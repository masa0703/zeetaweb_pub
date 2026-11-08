import { MCP_TOOL_REGISTRY } from './tool-registry'
import type { McpToolHandler } from './tool-context'
import { searchNodes } from './tools/search'
import {
  appendNodeContent,
  createNode,
  createNodeTree,
  editNodeContent,
  findInNode,
  getChildren,
  getParents,
  getRootNodeId,
  readNode,
  trashNode,
  updateNode,
  updateNodeTitle,
} from './tools/nodes'
import {
  linkNode,
  linkNodes,
  moveNode,
  moveNodes,
  unlinkNode,
  unlinkNodes,
  updateLinkRelationType,
} from './tools/relations'
import { createNodeImage, readNodeImage } from './tools/images'
import { readNodeHistory, restoreNodeVersion } from './tools/history'

/** ツール名 → ハンドラ。キー集合は MCP_TOOL_REGISTRY と完全一致する（下の整合チェックで保証）。 */
export const MCP_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  search_nodes: searchNodes,
  read_node: readNode,
  get_children: getChildren,
  find_in_node: findInNode,
  get_parents: getParents,
  create_node: createNode,
  link_node: linkNode,
  link_nodes: linkNodes,
  unlink_node: unlinkNode,
  unlink_nodes: unlinkNodes,
  move_node: moveNode,
  move_nodes: moveNodes,
  update_link_relation_type: updateLinkRelationType,
  read_node_history: readNodeHistory,
  restore_node_version: restoreNodeVersion,
  update_node: updateNode,
  update_node_title: updateNodeTitle,
  append_node_content: appendNodeContent,
  edit_node_content: editNodeContent,
  read_node_image: readNodeImage,
  create_node_image: createNodeImage,
  trash_node: trashNode,
  get_root_node_id: getRootNodeId,
  create_node_tree: createNodeTree,
}

// 登録漏れ・過剰登録を実行時起動エラーとして検出する整合チェック
const registeredToolNames = new Set(MCP_TOOL_REGISTRY.map((tool) => tool.name))
const handlerToolNames = new Set(Object.keys(MCP_TOOL_HANDLERS))
for (const toolName of registeredToolNames) {
  if (!handlerToolNames.has(toolName)) {
    throw new Error(`[mcp] MCP_TOOL_HANDLERS missing handler for registered tool: ${toolName}`)
  }
}
for (const toolName of handlerToolNames) {
  if (!registeredToolNames.has(toolName)) {
    throw new Error(`[mcp] MCP_TOOL_HANDLERS contains handler for unregistered tool: ${toolName}`)
  }
}
