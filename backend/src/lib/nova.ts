import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({
  region: process.env.NOVA_REGION ?? 'eu-central-1', maxAttempts: 2, retryMode: 'standard',
  requestHandler: { requestTimeout: 8000, throwOnRequestTimeout: true },
});

export class NovaError extends Error {
  constructor(public kind: 'unavailable' | 'malformed') {
    super(`Nova ${kind}`);
    this.name = 'NovaError';
  }
}

interface TextInput { system: string; user: string; maxTokens: number; }
interface ToolInput extends TextInput { tool: { name: string; description: string; schema: object }; }

async function converse<T>(input: TextInput, action: string, toolConfig: ConverseCommandInput['toolConfig'], extract: (response: ConverseCommandOutput) => T): Promise<T> {
  const start = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let outcome = 'ok';
  try {
    const response = await client.send(new ConverseCommand({
      modelId: process.env.NOVA_MODEL_ID ?? 'global.amazon.nova-2-lite-v1:0',
      system: [{ text: input.system }], messages: [{ role: 'user', content: [{ text: input.user }] }],
      inferenceConfig: { maxTokens: input.maxTokens, temperature: 0 },
      ...(toolConfig ? { toolConfig } : {}),
    }));
    inputTokens = response.usage?.inputTokens ?? 0;
    outputTokens = response.usage?.outputTokens ?? 0;
    return extract(response);
  } catch (error) {
    const failure = error instanceof NovaError ? error : new NovaError('unavailable');
    outcome = failure.kind;
    throw failure;
  } finally {
    console.log(JSON.stringify({ action, inputTokens, outputTokens, latencyMs: Date.now() - start, outcome }));
  }
}

export function converseText(input: TextInput): Promise<string> {
  return converse(input, 'converseText', undefined, response => {
    const text = (response.output?.message?.content ?? []).flatMap(block => block.text === undefined ? [] : [block.text]).join('');
    if (!text.trim()) throw new NovaError('malformed');
    return text;
  });
}

export function converseTool<T>(input: ToolInput): Promise<T> {
  return converse(input, input.tool.name, {
    tools: [{ toolSpec: { name: input.tool.name, description: input.tool.description,
      inputSchema: { json: input.tool.schema as ToolInputSchema.JsonMember['json'] },
    } }],
    toolChoice: { tool: { name: input.tool.name } },
  }, response => {
    const tool = response.output?.message?.content?.find(block => block.toolUse?.name === input.tool.name)?.toolUse;
    if (!tool || tool.input === undefined) throw new NovaError('malformed');
    return tool.input as T;
  });
}
