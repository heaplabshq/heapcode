// Minimal MCP server over stdio, spawned by mcp.test.ts as a real child
// process — proves McpManager's stdio transport, tool listing, and tool
// calling end to end (not mocked). Two tools: `echo`, which returns its
// `text` argument verbatim so the test can assert the round trip, and
// `whoami`, which reports the clientInfo.name this server received in the
// initialize handshake — the identity third-party servers actually see.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes back the given text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'whoami',
      description: 'Reports the client name seen in the initialize handshake.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo') {
    return { content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] };
  }
  if (request.params.name === 'whoami') {
    return { content: [{ type: 'text', text: server.getClientVersion()?.name ?? '<none>' }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
