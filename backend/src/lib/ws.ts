import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

let client: ApiGatewayManagementApiClient | undefined;
let endpoint: string | undefined;

export async function send(connectionId: string, payload: unknown): Promise<'sent' | 'gone'> {
  if (!client || endpoint !== process.env.WS_ENDPOINT) {
    endpoint = process.env.WS_ENDPOINT;
    client = new ApiGatewayManagementApiClient({ endpoint });
  }
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId, Data: JSON.stringify(payload),
    }));
    return 'sent';
  } catch (error) {
    if (error instanceof GoneException ||
      (error instanceof Error && error.name === 'GoneException') ||
      (typeof error === 'object' && error !== null && '$metadata' in error &&
        typeof error.$metadata === 'object' && error.$metadata !== null &&
        'httpStatusCode' in error.$metadata && error.$metadata.httpStatusCode === 410)) {
      return 'gone';
    }
    throw error;
  }
}
