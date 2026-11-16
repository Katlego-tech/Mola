import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const placeholders = (text) => [...new Set(text.match(/\{[^{}]+\}/g) ?? [])].sort();
const numbers = (text) => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.'))).sort((a, b) => a - b);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A translation must preserve the entire copy deck and its interpolated values. */
export function checkCatalog(source, translated) {
  if (!translated || typeof translated !== 'object' || Array.isArray(translated)) return false;
  if (!equal(Object.keys(source).sort(), Object.keys(translated).sort())) return false;
  return Object.entries(source).every(([key, value]) =>
    typeof translated[key] === 'string'
    && equal(placeholders(value), placeholders(translated[key]))
    && equal(numbers(value), numbers(translated[key])));
}

async function main() {
  const { values } = parseArgs({ options: {
    region: { type: 'string', default: 'eu-central-1' },
    model: { type: 'string', default: 'global.amazon.nova-2-lite-v1:0' },
    only: { type: 'string' },
  } });
  const languages = {
    zu: 'isiZulu (the Zulu language of South Africa, ISO 639-1 "zu"; not Swahili or Xhosa)',
    af: 'Afrikaans (South Africa)',
    st: 'Sesotho (Southern Sotho of South Africa and Lesotho, ISO 639-1 "st"; not Setswana or Sepedi)',
  };
  if (values.only && !Object.hasOwn(languages, values.only)) throw new Error('--only must be zu, af or st');
  const require = createRequire(new URL('../backend/package.json', import.meta.url));
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const source = JSON.parse(await readFile(new URL('../frontend/src/i18n/en.json', import.meta.url), 'utf8'));
  const client = new BedrockRuntimeClient({ region: values.region, maxAttempts: 1 });
  try {
    for (const [lang, name] of Object.entries(languages)) {
      if (values.only && values.only !== lang) continue;
      try {
        // A forced tool call returns structured input, which survives quotes and escapes that break
        // a free-text JSON reply.
        const keys = Object.keys(source);
        const response = await client.send(new ConverseCommand({
          modelId: values.model,
          system: [{ text: `Translate each value of the user's JSON object into ${name} and call \`catalog\` with the result. Keep the keys. Keep every \`{placeholder}\` exactly. These are short labels on a phone screen for people waiting in a government office; use plain, polite, everyday words.` }],
          messages: [{ role: 'user', content: [{ text: JSON.stringify(source) }] }],
          inferenceConfig: { maxTokens: 6000, temperature: 0 },
          toolConfig: {
            tools: [{ toolSpec: { name: 'catalog', description: `The patron page copy in ${name}.`, inputSchema: { json: {
              type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])), required: keys, additionalProperties: false,
            } } } }],
            toolChoice: { tool: { name: 'catalog' } },
          },
        }));
        const translated = response.output?.message?.content?.find((block) => block.toolUse?.name === 'catalog')?.toolUse?.input;
        if (!translated || typeof translated !== 'object') throw new Error(`No catalog returned (stop reason ${response.stopReason})`);
        const broken = keys.filter((key) => !checkCatalog({ [key]: source[key] }, { [key]: translated[key] }));
        if (broken.length) throw new Error(`Translation changed keys, placeholders or numbers: ${broken.join(', ')}`);
        if (!checkCatalog(source, translated)) throw new Error('Translation changed keys, placeholders or numbers');
        await writeFile(new URL(`../frontend/src/i18n/${lang}.json`, import.meta.url), `${JSON.stringify({
          ...translated,
          _meta: { model: values.model, generatedAt: new Date().toISOString(), reviewedBy: null },
        }, null, 2)}\n`);
        console.log(`${lang}: catalog written`);
      } catch (error) {
        console.error(`${lang}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
