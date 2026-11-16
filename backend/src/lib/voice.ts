import { createHash } from 'node:crypto';
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const polly = new PollyClient({ maxAttempts: 2, retryMode: 'standard', requestHandler: { requestTimeout: 4000, throwOnRequestTimeout: true } });
const s3 = new S3Client({ maxAttempts: 2, retryMode: 'standard', requestHandler: { requestTimeout: 2000, throwOnRequestTimeout: true } });

export async function speechUrl(text: string, onCache?: (cached: boolean) => void): Promise<string> {
  const voiceId = process.env.VOICE_ID ?? 'Ayanda';
  const Bucket = process.env.VOICE_BUCKET;
  const hash = createHash('sha256').update(voiceId + text).digest('hex');
  const Key = `voice/${hash}.mp3`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
    onCache?.(true);
    return `/${Key}`;
  } catch (error) {
    if (!((error instanceof Error && (error.name === 'NotFound' || error.name === 'AccessDenied')) ||
      (typeof error === 'object' && error !== null && '$metadata' in error &&
        typeof error.$metadata === 'object' && error.$metadata !== null &&
        'httpStatusCode' in error.$metadata && error.$metadata.httpStatusCode === 403))) throw error;
  }
  onCache?.(false);
  const { AudioStream } = await polly.send(new SynthesizeSpeechCommand({
    Text: text, VoiceId: voiceId as VoiceId, Engine: 'neural', OutputFormat: 'mp3', SampleRate: '22050',
  }));
  if (!AudioStream) throw new Error('Polly returned no audio');
  const Body = await AudioStream.transformToByteArray();
  await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'audio/mpeg', CacheControl: 'public, max-age=86400, immutable' }));
  return `/${Key}`;
}
