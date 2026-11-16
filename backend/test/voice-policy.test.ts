import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('allows bucket listing for speech cache checks without a prefix condition', () => {
  const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
  const assist = template.split('  AssistFunction:')[1]?.split('  Metadata:')[0];
  const statement = assist?.match(/ {12}- Effect: Allow\n {14}Action: s3:ListBucket\n(?:(?! {12}- Effect:)[\s\S])*/)?.[0];
  expect(statement).toContain('Resource: !GetAtt WebBucket.Arn');
  expect(statement).not.toContain('Condition:');
});
