import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { send } from '../src/lib/ws';

const mock = mockClient(ApiGatewayManagementApiClient);
beforeEach(() => { mock.reset(); vi.stubEnv('WS_ENDPOINT', 'https://example.execute-api.af-south-1.amazonaws.com/prod'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('send', () => {
  it('posts the JSON payload to the configured endpoint', async () => {
    let endpoint: unknown;
    mock.on(PostToConnectionCommand).callsFake(async (_input, getClient) => {
      const provider = getClient().config.endpoint;
      endpoint = provider ? await provider() : undefined;
      return {};
    });
    const payload = { type: 'status', ticketNo: 42, text: '你好' };
    expect(await send('c', payload)).toBe('sent');
    expect(mock.commandCalls(PostToConnectionCommand)).toHaveLength(1);
    expect(mock.commandCalls(PostToConnectionCommand)[0]?.args[0].input).toEqual({ ConnectionId: 'c', Data: JSON.stringify(payload) });
    expect(endpoint).toMatchObject({ protocol: 'https:', hostname: 'example.execute-api.af-south-1.amazonaws.com', path: '/prod' });
  });

  it.each([
    new GoneException({ message: 'gone', $metadata: { httpStatusCode: 410 } }),
    Object.assign(new Error('gone'), { name: 'GoneException' }),
    Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 410 } }),
  ])('maps a gone connection to gone', async error => {
    mock.on(PostToConnectionCommand).rejects(error);
    expect(await send('c', {})).toBe('gone');
    expect(mock.calls()).toHaveLength(1);
  });

  it.each([new Error('network'), Object.assign(new Error('forbidden'), { $metadata: { httpStatusCode: 403 } })])('throws other failures unchanged', async error => {
    mock.on(PostToConnectionCommand).rejects(error);
    await expect(send('c', {})).rejects.toBe(error);
  });

  it('propagates JSON serialization failures without posting', async () => {
    await expect(send('c', 1n)).rejects.toBeInstanceOf(TypeError);
    expect(mock.calls()).toHaveLength(0);
  });
});
