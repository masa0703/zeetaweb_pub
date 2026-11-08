export type McpToolAccessLevel = 'read' | 'write'
export type McpPermissionPreset = 'full_access' | 'read_only'

export type McpToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  accessLevel: McpToolAccessLevel
}

const createNodeTreeNodeInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    content: { type: 'string' },
    child_sort_mode: { type: 'string', enum: ['manual', 'created_at', 'updated_at', 'title'] },
    child_sort_direction: { type: 'string', enum: ['asc', 'desc'] },
    relation_type: { type: ['string', 'null'], enum: ['STRUCTURAL', 'REFERENCE', null] },
    relation_type_id: { type: 'integer' },
    children: {
      type: 'array',
      items: { $ref: '#/$defs/createNodeTreeNodeInput' },
    },
  },
  required: ['title'],
}

export const MCP_TOOL_REGISTRY: McpToolDefinition[] = [
  {
    name: 'search_nodes',
    accessLevel: 'read',
    description: 'Search nodes using hybrid search: keyword match AND vector/semantic similarity.\n- Results include version for optimistic locking.\n- IMPORTANT: results are in items[] (combined total). word[] = keyword matches only, vector[] = semantically similar only\n- returned = total count of items (word + vector combined). Even when word=[] and returned=0 by old count, vector[] may have relevant results — always use items[]\n- Required: keyword (query is accepted as alias)\n- Space-separated keywords use AND/OR via match_mode (default: and)\n- Searches both title and content; set only_title=true to match titles only (vector search is skipped)\n- Exclude terms with exclude_keywords\n- Optionally scope with parent_node_id (6-character base58 public node ID)\n- Sort by created_at/updated_at with sort_order (default: updated_at desc)\n- Use broad single keywords to avoid missing results\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- All node IDs in results are 6-character base58 public IDs',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        query: { type: 'string' },
        parent_node_id: { type: 'string', description: '6-character base58 public node ID' },
        match_mode: { type: 'string', enum: ['and', 'or'] },
        sort_by: { type: 'string', enum: ['created_at', 'updated_at'] },
        sort_order: { type: 'string', enum: ['asc', 'desc'] },
        exclude_keywords: { type: 'string' },
        only_title: { type: 'boolean', description: 'When true, match titles only (content is not searched and vector search is skipped). Defaults to false.' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'read_node',
    accessLevel: 'read',
    description: 'Read a node with full details.\n- Returns id, title, content, author, created_at, updated_at, version (for optimistic locking), child_sort_mode, child_sort_direction, content_total_lines, children, parents, path and path_relation_mode\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- children[] and parents[] entries each have id, title and relation_type_name\n- children[].relation_type_name means this node -> child\n- parents[].relation_type_name means parent -> this node\n- content_offset and content_limit are echoed back in the response, but only when the content was sliced\n- include_images=true adds images[]; each entry has id, filename and content_type; default false\n- content_total_lines is the line count of the whole content and does not change with content_offset/content_limit\n- node_id must be a 6-character base58 public node ID; all node IDs in the response are public IDs',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        include_images: { type: 'boolean', description: 'When true, include image metadata as images[]. Defaults to false.' },
        content_offset: { type: 'integer', description: 'Optional zero-based line offset for content.' },
        content_limit: { type: 'integer', description: 'Optional number of content lines to return.' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'get_children',
    accessLevel: 'read',
    description: 'Get child nodes of a node with details.\n- Returns each child with title, content, author, timestamps, path, and child sort settings\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- Does not include child children/parents payloads\n- include_images=true adds images[] metadata to each item; default false\n- Supports limit/offset pagination\n- node_id must be a 6-character base58 public node ID; all node IDs in the response are public IDs',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        include_images: { type: 'boolean', description: 'When true, include image metadata on each item as images[]. Defaults to false.' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'find_in_node',
    accessLevel: 'read',
    description: 'Find a keyword in node content and return matching lines (1-based) with total match count. Defaults to 20 returned matches. Returns node_id, keyword, total, limit, returned and items; each item has line (1-based line number) and text (the whole line).',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        keyword: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum matches to return; defaults to 20.' },
      },
      required: ['node_id', 'keyword'],
    },
  },
  {
    name: 'get_parents',
    accessLevel: 'read',
    description: 'Get parent nodes of a node with details.\n- Returns each parent with title, content, author, timestamps, path\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- Does not include parent children/parents payloads\n- Supports limit/offset pagination\n- node_id must be a 6-character base58 public node ID; all node IDs in the response are public IDs',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'create_node',
    accessLevel: 'write',
    description: 'Create a new node under parent_ids.\n- parent_ids is required\n- Supports multi-parent creation\n- relation_type or relation_type_id can be specified\n- child_sort_mode and child_sort_direction can be specified; if omitted, defaults are used\n- created_at and updated_at can be specified to restore timestamps; if omitted, the existing automatic timestamp behavior is used\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- parent_ids must be 6-character base58 public node IDs; the returned node id is a public ID',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        child_sort_mode: { type: 'string', enum: ['manual', 'created_at', 'updated_at', 'title'] },
        child_sort_direction: { type: 'string', enum: ['asc', 'desc'] },
        parent_ids: { type: 'array', items: { type: 'string', description: '6-character base58 public node ID' } },
        relation_type: { type: ['string', 'null'], enum: ['STRUCTURAL', 'REFERENCE', null] },
        relation_type_id: { type: 'integer' },
        created_at: { type: 'string', description: 'Optional creation timestamp. If specified, this value is used; if omitted, the existing default automatic timestamp behavior is used.' },
        updated_at: { type: 'string', description: 'Optional update timestamp. If specified, this value is used; if omitted, the existing default automatic timestamp behavior is used.' },
      },
      required: ['title', 'parent_ids'],
    },
  },
  {
    name: 'link_node',
    accessLevel: 'write',
    description: 'Create one parent-child link between existing nodes.\n- child_id and parent_id are required\n- relation_type can be set\n- Cyclic links are rejected\n- child_id and parent_id must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        child_id: { type: 'string', description: '6-character base58 public node ID' },
        parent_id: { type: 'string', description: '6-character base58 public node ID' },
        relation_type: { type: ['string', 'null'], enum: ['STRUCTURAL', 'REFERENCE', null] },
        relation_type_id: { type: 'integer' },
      },
      required: ['child_id', 'parent_id'],
    },
  },
  {
    name: 'link_nodes',
    accessLevel: 'write',
    description: 'Create multiple parent-child links in one call.\n- links[] accepts {child_id, parent_id}\n- relation_type can be set per link\n- Cyclic links are rejected\n- All child_id and parent_id values must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              child_id: { type: 'string', description: '6-character base58 public node ID' },
              parent_id: { type: 'string', description: '6-character base58 public node ID' },
              relation_type: { type: ['string', 'null'], enum: ['STRUCTURAL', 'REFERENCE', null] },
              relation_type_id: { type: 'integer' },
            },
            required: ['child_id', 'parent_id'],
          },
        },
      },
      required: ['links'],
    },
  },
  {
    name: 'unlink_node',
    accessLevel: 'write',
    description: 'Remove one parent-child link.\n- Deletes only the specified edge\n- Node data remains\n- Rejected if this is the node\'s only parent (a node must keep at least one parent): use move_node to relocate it, or trash_node to delete it\n- child_id and parent_id must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        child_id: { type: 'string', description: '6-character base58 public node ID' },
        parent_id: { type: 'string', description: '6-character base58 public node ID' },
      },
      required: ['child_id', 'parent_id'],
    },
  },
  {
    name: 'unlink_nodes',
    accessLevel: 'write',
    description: 'Remove multiple parent-child links in one call.\n- links[] accepts {child_id, parent_id}\n- The same child_id cannot appear more than once per batch\n- A link is rejected if it is the child\'s only parent (a node must keep at least one parent); on any failure the whole batch is rolled back\n- All child_id and parent_id values must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              child_id: { type: 'string', description: '6-character base58 public node ID' },
              parent_id: { type: 'string', description: '6-character base58 public node ID' },
            },
            required: ['child_id', 'parent_id'],
          },
        },
      },
      required: ['links'],
    },
  },
  {
    name: 'move_node',
    accessLevel: 'write',
    description: 'Move a node from one parent to another (relink in one atomic operation).\n- Removes the child_id -> from_parent_id edge and adds child_id under to_parent_id\n- Only the specified parent edge is changed; other parents of child_id are untouched\n- The relation_type of the moved edge is inherited from the original from_parent_id edge\n- Rejected on cycles, self-move, when from_parent_id and to_parent_id are equal, when child_id is not linked to from_parent_id, or when child_id is already linked to to_parent_id\n- child_id, from_parent_id and to_parent_id must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        child_id: { type: 'string', description: '6-character base58 public node ID' },
        from_parent_id: { type: 'string', description: '6-character base58 public node ID (current parent)' },
        to_parent_id: { type: 'string', description: '6-character base58 public node ID (new parent)' },
      },
      required: ['child_id', 'from_parent_id', 'to_parent_id'],
    },
  },
  {
    name: 'move_nodes',
    accessLevel: 'write',
    description: 'Move multiple nodes between parents in one call.\n- moves[] accepts {child_id, from_parent_id, to_parent_id}\n- Each move inherits the relation_type of its original from_parent_id edge\n- The same child_id cannot appear more than once per batch\n- On any failure the whole batch is rolled back (nothing is applied)\n- All node IDs must be 6-character base58 public node IDs',
    inputSchema: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              child_id: { type: 'string', description: '6-character base58 public node ID' },
              from_parent_id: { type: 'string', description: '6-character base58 public node ID (current parent)' },
              to_parent_id: { type: 'string', description: '6-character base58 public node ID (new parent)' },
            },
            required: ['child_id', 'from_parent_id', 'to_parent_id'],
          },
        },
      },
      required: ['moves'],
    },
  },
  {
    name: 'update_link_relation_type',
    accessLevel: 'write',
    description: 'Update relation_type of an existing link.\n- Requires child_id and parent_id\n- Use relation_type or relation_type_id\n- child_id and parent_id must be 6-character base58 public node IDs\n- A node keeps one STRUCTURAL parent: changing a link to STRUCTURAL changes the other STRUCTURAL parents of child_id to REFERENCE (returned as demoted_parent_ids)\n- Changing the last STRUCTURAL link of child_id to another type is rejected',
    inputSchema: {
      type: 'object',
      properties: {
        child_id: { type: 'string', description: '6-character base58 public node ID' },
        parent_id: { type: 'string', description: '6-character base58 public node ID' },
        relation_type: { type: ['string', 'null'], enum: ['STRUCTURAL', 'REFERENCE', null] },
        relation_type_id: { type: 'integer' },
      },
      required: ['child_id', 'parent_id'],
    },
  },
  {
    name: 'read_node_history',
    accessLevel: 'read',
    description: 'Read saved content snapshots for a node, newest first. Defaults to 20 rows; content is included only when include_content=true. Each row includes node_version, replaced_at, and actor information. node_version is the version of the content held by that snapshot (the version before it was replaced), and replaced_at is the time that version was replaced. node_version values can skip numbers and that is normal, not an error: the node version also advances on changes that do not replace content (a title-only update, or a write whose content equals the stored content), and those create no snapshot. Rows beyond the retention policy (newest 100 per node) are also removed. Restore by node_version; there is no other row identifier. Returns node_id, current_version, total, limit, returned and items; each item has node_version, replaced_at, source and actor (actor has user_id, display_name, email and client_name).',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        limit: { type: 'integer', description: 'Maximum rows to return; defaults to 20.' },
        include_content: { type: 'boolean', description: 'When true, include full snapshot content.' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'restore_node_version',
    accessLevel: 'write',
    description: 'Restore a node content snapshot by absolute node_version. if_version is required for optimistic locking. The restore itself creates a new snapshot. Returns success, node_id, version and updated_at.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        node_version: { type: 'integer', description: 'Snapshot node_version to restore.' },
        if_version: { type: 'integer', description: 'Required expected current node version.' },
      },
      required: ['node_id', 'node_version', 'if_version'],
    },
  },
  {
    name: 'update_node',
    accessLevel: 'write',
    description: 'Update an existing node.\n- node_id is required\n- title/content/child sort settings are optional partial updates\n- if content is provided, if_version is required and must match the version returned by read_node/search_nodes\n- if_version is optional when content is omitted\n- version conflicts return a tool error containing current_version and the current server_data\n- unspecified fields are kept: to change ONLY the title, send just node_id + title and OMIT content (do NOT read the node first, do NOT resend content)\n- for a title-only change prefer the dedicated update_node_title tool\n- created_at and updated_at can be specified to restore timestamps; if omitted, the existing automatic timestamp behavior is used (updated_at is set to the current time, created_at is left unchanged)\n- at least one of title/content/created_at/updated_at/child_sort_mode/child_sort_direction must be provided\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        title: { type: 'string' },
        content: { type: 'string' },
        if_version: { type: 'integer', description: 'Required when content is provided; expected current node version.' },
        child_sort_mode: { type: 'string', enum: ['manual', 'created_at', 'updated_at', 'title'] },
        child_sort_direction: { type: 'string', enum: ['asc', 'desc'] },
        created_at: { type: 'string', description: 'Optional creation timestamp. If specified, this value is used; if omitted, the existing creation timestamp is left unchanged.' },
        updated_at: { type: 'string', description: 'Optional update timestamp. If specified, this value is used; if omitted, updated_at is set to the current time as before.' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'update_node_title',
    accessLevel: 'write',
    description: 'Rename a node (change its title only).\n- node_id and title are required\n- if_version is optional; when supplied it must match the current version\n- version conflicts return a tool error containing current_version and the current server_data\n- content is never read or modified; you do NOT need to fetch the node first\n- token-efficient: use this instead of update_node when only the title changes\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        title: { type: 'string' },
        if_version: { type: 'integer', description: 'Optional expected current node version.' },
      },
      required: ['node_id', 'title'],
    },
  },
  {
    name: 'append_node_content',
    accessLevel: 'write',
    description: 'Append content to an existing node.\n- node_id and content are required\n- Appends with one newline when existing content is not empty\n- Useful for chunked long-text writes\n- Returns the updated node: id, title, content, author, created_at, updated_at, version, child_sort_mode, child_sort_direction, path and path_relation_mode\n- path is a breadcrumb whose segments each carry the node public id, like `root (id:xxxxxx) > parent title (id:yyyyyy)`\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        content: { type: 'string' },
      },
      required: ['node_id', 'content'],
    },
  },
  {
    name: 'edit_node_content',
    accessLevel: 'write',
    description: 'Replace exact strings in node content. Use either scalar old_str/new_str for one edit or edits[] for a sequential batch, but not both. Zero matches or multiple matches with replace_all=false are errors and do not modify content; one match is replaced, or all matches when replace_all=true. A batch validates all edits before applying one snapshot and one version increment. if_version is optional and is checked once for the whole operation. On success returns success, node_id, version, updated_at, applied (how many edits were applied) and match_counts (matches per edit); the scalar form additionally returns match_count. On failure the tool error carries a fixed error code (No match, Multiple matches, Invalid argument or Version conflict) in error, a human-readable message, and for match failures edit_index, match_count and match_lines.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace all matches; defaults to false.' },
        edits: { type: 'array', description: 'Sequential edits. Each item has old_str, new_str, and optional replace_all.', items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_str', 'new_str'] } },
        if_version: { type: 'integer', description: 'Optional expected current node version.' },
      },
      // node_id だけが必須。old_str/new_str と edits[] は排他なので、
      // どちらかを required にするとスキーマ準拠のクライアントから他方が呼べなくなる
      // （old_str を必須にしていたため edits[] が事実上使用不能だった）
      required: ['node_id'],
    },
  },
  {
    name: 'read_node_image',
    accessLevel: 'read',
    description: 'Read one node image as base64.\n- node_id and image_id are required\n- Returns filename, content_type, and data_base64\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        image_id: { type: 'integer' },
      },
      required: ['node_id', 'image_id'],
    },
  },
  {
    name: 'create_node_image',
    accessLevel: 'write',
    description: 'Create one node image from base64 data.\n- node_id, filename, content_type, and data_base64 are required\n- Returns image_id and URL for Markdown replacement\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
        filename: { type: 'string' },
        content_type: { type: 'string' },
        data_base64: { type: 'string' },
      },
      required: ['node_id', 'filename', 'content_type', 'data_base64'],
    },
  },
  {
    name: 'trash_node',
    accessLevel: 'write',
    description: 'Move a node to trash.\n- Safe delete (not permanent)\n- Restorable from trash view\n- node_id must be a 6-character base58 public node ID',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '6-character base58 public node ID' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'get_root_node_id',
    accessLevel: 'read',
    description: 'Get the scope root node_id.\n- Call this first\n- Use the returned id as default traversal start\n- The returned id is a 6-character base58 public node ID',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_node_tree',
    accessLevel: 'write',
    description: 'Recursively create a subtree under parent_node_id.\n- nodes[] defines hierarchical input\n- relation_type can be set per node\n- Useful for bulk import\n- parent_node_id must be a 6-character base58 public node ID; returned node IDs are public IDs',
    inputSchema: {
      type: 'object',
      properties: {
        parent_node_id: { type: 'string', description: '6-character base58 public node ID' },
        nodes: {
          type: 'array',
          items: { $ref: '#/$defs/createNodeTreeNodeInput' },
        },
      },
      $defs: {
        createNodeTreeNodeInput: createNodeTreeNodeInputSchema,
      },
      required: ['parent_node_id', 'nodes'],
    },
  },
]

export function isMcpPermissionPreset(value: string): value is McpPermissionPreset {
  return value === 'full_access' || value === 'read_only'
}

export function getAllowedMcpTools(permissionPreset: McpPermissionPreset): McpToolDefinition[] {
  if (permissionPreset === 'full_access') {
    return MCP_TOOL_REGISTRY
  }
  return MCP_TOOL_REGISTRY.filter((tool) => tool.accessLevel === 'read')
}

export function findMcpToolDefinition(toolName: string): McpToolDefinition | undefined {
  return MCP_TOOL_REGISTRY.find((tool) => tool.name === toolName)
}

export function isToolAllowedForPreset(
  permissionPreset: McpPermissionPreset,
  accessLevel: McpToolAccessLevel,
): boolean {
  if (permissionPreset === 'full_access') {
    return true
  }
  return accessLevel === 'read'
}
