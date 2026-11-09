import { TrueForge } from '@truefoundry/trueforge-sdk';
import { MCP_SERVER_NAME } from './runner';

/** Registers (or re-points) the extension's MCP server in TrueForge's connector settings. */
export async function registerMcpServer(client: TrueForge, url: string, token: string): Promise<void> {
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name: MCP_SERVER_NAME,
      url,
      description: 'VS Code workspace tools from the Forge Agent extension: read, search, symbols, reviewed edits, commands.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    },
  } as never);
}
