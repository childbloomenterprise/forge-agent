import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, ToolDeps } from './tools';

export interface RunningMcpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Stateless Streamable-HTTP MCP server bound to 127.0.0.1, protected by a per-launch bearer token. */
export async function startMcpServer(deps: ToolDeps, port: number): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString('hex');
  const httpServer = http.createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return void res.writeHead(400).end();
    }
    const server = new McpServer({ name: 'forge-editor', version: '0.1.0' });
    registerTools(server, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    token,
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
