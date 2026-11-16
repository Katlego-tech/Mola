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
  const languages = { zu: 'isiZulu', af: 'Afrikaans', st: 'Sesotho' };
  if (values.only && !Object.hasOwn(languages, values.only)) throw new Error('--only must be zu, af or st');
  const require = createRequire(new URL('../backend/package.json', import.meta.url));
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const source = JSON.parse(await readFile(new URL('../frontend/src/i18n/en.json', import.meta.url), 'utf8'));
  const client = new BedrockRuntimeClient({ region: values.region, maxAttempts: 1 });
  try {
    for (const [lang, name] of Object.entries(languages)) {
      if (values.only && values.only !== lang) continue;
      try {
        const response = await client.send(new ConverseCommand({
          modelId: values.model,
          system: [{ text: `Translate each value of this JSON object into ${name}. Keep the keys. Keep every \`{placeholder}\` exactly. These are short labels on a phone screen for people waiting in a government office; use plain, polite, everyday words. Return only JSON.` }],
          messages: [{ role: 'user', content: [{ text: JSON.stringify(source) }] }],
          inferenceConfig: { maxTokens: 4000, temperature: 0 },
        }));
        const text = (response.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
        const translated = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
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
