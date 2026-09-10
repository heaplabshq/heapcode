// An OAuth-protected MCP server, in-process, for proving the sign-in flow end
// to end without a third party.
//
// Notion answers `server_error` from its own code exchange after a successful
// consent — a fault on its side, past anything a client controls — which left
// the implementation verified only up to the point another company's beta
// stopped working. This fixture removes that dependency: it implements the
// same four specs Notion does (RFC 9728 discovery, RFC 7591 registration,
// authorization-code + PKCE, RFC 8707 resource) and nothing else, so a test
// can walk the whole flow and assert on each step.
//
// Consent is automatic. The browser is the one part of this that cannot be
// faked, and it is also the part that carries no logic of ours.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * @param {{ requireResource?: boolean }} [opts]
 *   `requireResource` makes RFC 8707 audience binding mandatory, so a test can
 *   assert we send it rather than merely that things work without it.
 */
export async function startOAuthMcpServer(opts = {}) {
  /** Registered clients, by client_id. */
  const clients = new Map();
  /** Issued authorization codes, single-use, holding their PKCE challenge. */
  const codes = new Map();
  /** Live access tokens -> the refresh token that may renew them. */
  const tokens = new Map();
  const refreshTokens = new Map();
  /** Everything the server was asked, so a test can assert on the request. */
  const seen = { registrations: [], authorizations: [], tokenRequests: [] };

  let origin = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    const path = url.pathname;

    // RFC 9728: what a 401 points at.
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['default'],
        bearer_methods_supported: ['header'],
      });
    }

    // RFC 8414: where to register, authorize and exchange.
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ['default'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    // RFC 7591: dynamic registration. Public client, no secret — the posture
    // a local app has to use, since it cannot keep one.
    if (path === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      seen.registrations.push(body);
      const client_id = `client-${clients.size + 1}`;
      const record = { ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) };
      clients.set(client_id, record);
      return json(res, 201, record);
    }

    // Consent, granted automatically.
    if (path === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      seen.authorizations.push(q);
      const client = clients.get(q.client_id);
      if (!client) return json(res, 400, { error: 'invalid_client' });
      if (!client.redirect_uris.includes(q.redirect_uri)) return json(res, 400, { error: 'invalid_redirect_uri' });
      if (q.code_challenge_method !== 'S256') return json(res, 400, { error: 'invalid_request' });
      if (opts.requireResource && q.resource !== `${origin}/mcp`) {
        return json(res, 400, { error: 'invalid_target', error_description: 'resource is required' });
      }

      const code = randomUUID();
      codes.set(code, { challenge: q.code_challenge, client_id: q.client_id, redirect_uri: q.redirect_uri });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      // Returned verbatim: the client's own CSRF check depends on it.
      if (q.state) back.searchParams.set('state', q.state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (path === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      seen.tokenRequests.push(form);

      if (form.grant_type === 'refresh_token') {
        const owner = refreshTokens.get(form.refresh_token);
        if (!owner) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(owner, form.refresh_token));
      }

      const issued = codes.get(form.code);
      // Single-use in every outcome, valid or not.
      codes.delete(form.code);
      if (!issued) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown or spent code' });
      if (issued.redirect_uri !== form.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
      // The whole point of PKCE: the verifier must answer the challenge sent
      // at authorize time, which only the client that started this can do.
      const digest = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (digest !== issued.challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return json(res, 200, issue(issued.client_id));
    }

    if (path === '/mcp') {
      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!tokens.has(bearer)) {
        // Exactly the challenge Notion answers with, and what makes a client
        // discover where to authenticate.
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        });
        return res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      return handleMcp(req, res);
    }

    return json(res, 404, { error: 'not_found' });
  });

  function issue(clientId, reuseRefresh) {
    const access = `access-${randomUUID()}`;
    const refresh = reuseRefresh ?? `refresh-${randomUUID()}`;
    tokens.set(access, clientId);
    refreshTokens.set(refresh, clientId);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'default' };
  }

  /** Just enough MCP to initialize and list/call one tool. */
  async function handleMcp(req, res) {
    // A streamable-HTTP client also opens an SSE stream (GET) and terminates
    // its session (DELETE). Both are optional for a server to support, and
    // declining them is a normal answer — but they must be answered, not
    // parsed as JSON-RPC.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const raw = await readBody(req);
    if (!raw) {
      res.writeHead(202);
      return res.end();
    }
    const message = JSON.parse(raw);
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'oauth-fixture', version: '0.0.1' },
      });
    }
    if (message.method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'whoami',
            description: 'Reports that the caller is authenticated.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    }
    if (message.method === 'tools/call') {
      return reply({ content: [{ type: 'text', text: 'authenticated' }] });
    }
    // Notifications carry no id and want no body.
    res.writeHead(202).end();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    seen,
    /** Live access tokens, so a test can revoke one and force a refresh. */
    revokeAccessTokens: () => tokens.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
