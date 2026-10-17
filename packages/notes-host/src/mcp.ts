import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { COMMANDS, checkArgs } from './commands.js';
import { NoteError } from './errors.js';
import type { Vault } from './vault.js';

const INSTRUCTIONS = `Heapnotes: the user's notes, a folder of Markdown files.

- Find notes with search_notes (Bear's search syntax) or list_notes; then read_note.
- Every read returns a hash. Pass it as base on append_to_note / overwrite_note / edit_note: the write is refused if the user changed the note meanwhile, so read again and retry instead of overwriting their edit.
- Work on part of a long note: outline_note gives each section's address; pass it as section to read or write just that part.
- edit_note needs text that appears exactly once; check with search_in_note if unsure.
- Tags are #tag, #nested/tag or #multi word tag#; links are [[Note title]]. Renaming a note's title keeps links to it working.
- Trash is recoverable (restore_note). Nothing here deletes a note for good.`;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * The Heapnotes MCP server: the command table as tools.
 * The commands that delete for good (delete_note, empty_trash) stay CLI-only.
 */
export function createNotesMcpServer(vault: Vault, version: string): Server {
  const tools = COMMANDS.filter((c) => !c.cliOnly);
  const server = new Server(
    { name: 'heapnotes', version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((c) => ({
      name: c.name,
      description: c.description,
      inputSchema: c.input,
      annotations: {
        readOnlyHint: c.readOnly,
        destructiveHint: !c.readOnly && /overwrite|trash|delete|remove|rename/.test(c.name),
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const cmd = tools.find((c) => c.name === req.params.name);
    if (!cmd)
      return failure(new NoteError('invalid_argument', `No tool named ${req.params.name}.`));
    try {
      const result = await cmd.run(vault, checkArgs(cmd, req.params.arguments ?? {}));
      if (cmd.name === 'read_attachment')
        return attachmentResult(result as { filename: string; base64: string; image: boolean });
      return {
        content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }],
        structuredContent: wrap(result),
      };
    } catch (err) {
      return failure(err);
    }
  });

  return server;
}

/** Serve over stdin/stdout until the client goes away. */
export async function serveNotesMcp(vault: Vault, version: string): Promise<void> {
  const server = createNotesMcpServer(vault, version);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}

function attachmentResult(r: { filename: string; base64: string; image: boolean }): CallToolResult {
  const ext = r.filename.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME[ext];
  const { base64, ...meta } = r;
  if (r.image && mime) {
    return {
      content: [
        { type: 'text', text: JSON.stringify(meta) },
        { type: 'image', data: base64, mimeType: mime },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
}

function failure(err: unknown): CallToolResult {
  const e =
    err instanceof NoteError
      ? err
      : new NoteError('io', err instanceof Error ? err.message : String(err));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.toJSON()) }] };
}

/** structuredContent must be an object; lists come back as { items }. */
function wrap(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result))
    return result as Record<string, unknown>;
  return { items: result ?? [] };
}
