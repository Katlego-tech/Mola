// Vitest global setup for the integration project: runs DynamoDB Local in a container for the
// length of the run and tells the tests where it listens. Docker is required; if it is missing the
// run fails, because a check that cannot run is a failed check, not a skipped one.
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

// Pinned by digest: amazon/dynamodb-local, built 2026-10-15.
const IMAGE = 'amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';

export default async function setup(project: TestProject) {
  const id = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::8000', IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory'], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port', id, '8000/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
  const endpoint = `http://127.0.0.1:${port}`;

  // Wait until it answers HTTP (any status means the server is up).
  for (let i = 0; ; i += 1) {
    try {
      await fetch(endpoint, { method: 'POST' });
      break;
    } catch {
      if (i === 60) throw new Error('DynamoDB Local did not start within 30 s');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  project.provide('dynamodbEndpoint', endpoint);
  return () => {
    execFileSync('docker', ['stop', id]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}
