import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { converseText, converseTool, NovaError } from '../src/lib/nova';

const bedrock = mockClient(BedrockRuntimeClient);
const input = { system: 'Rules', user: 'Question', maxTokens: 300 };
const tool = { name: 'answer', description: 'Answer from notes', schema: { type: 'object' } };

beforeEach(() => { bedrock.reset(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Nova Converse wrapper', () => {
  it('sets model, system, user, token limit and temperature and combines text blocks', async () => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text: 'First' }, { text: 'Second' }] } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    expect(await converseText(input)).toBe('FirstSecond');
    expect(bedrock.call(0).args[0].input).toMatchObject({ modelId: 'global.amazon.nova-2-lite-v1:0', system: [{ text: input.system }],
      messages: [{ role: 'user', content: [{ text: input.user }] }], inferenceConfig: { maxTokens: 300, temperature: 0 } });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string)).toEqual({ action: 'converseText', inputTokens: 10, outputTokens: 2, latencyMs: expect.any(Number), outcome: 'ok' });
  });
  it('forces the named tool and returns its input', async () => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'answer-call', name: 'answer', input: { found: false, answer: '' } } }] } } });
    expect(await converseTool({ ...input, tool })).toEqual({ found: false, answer: '' });
    expect(bedrock.call(0).args[0].input).toMatchObject({ toolConfig: { toolChoice: { tool: { name: 'answer' } }, tools: [{ toolSpec: { name: 'answer', description: tool.description, inputSchema: { json: tool.schema } } }] } });
  });
  it.each(['text', 'tool'] as const)('rejects malformed %s responses and logs once without content', async kind => {
    bedrock.on(ConverseCommand).resolves({});
    const promise = kind === 'text' ? converseText(input) : converseTool({ ...input, tool });
    await expect(promise).rejects.toMatchObject({ kind: 'malformed' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).not.toContain('Question');
  });
  it('wraps Bedrock failures without leaking their messages', async () => {
    bedrock.on(ConverseCommand).rejects(new Error('private content'));
    await expect(converseText(input)).rejects.toBeInstanceOf(NovaError);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls[0]?.[0]).not.toContain('private content');
  });
  it('uses an overridden model', async () => {
    vi.stubEnv('NOVA_MODEL_ID', 'eu.amazon.nova-2-lite-v1:0');
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text: 'Translated' }] } } });
    await converseText(input);
    expect(bedrock.call(0).args[0].input).toHaveProperty('modelId', 'eu.amazon.nova-2-lite-v1:0');
  });
});
