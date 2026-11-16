import { verifySecret } from './secret';

export function verifyStaffKey(presented: string): boolean {
  return verifySecret(presented, process.env.STAFF_KEY_SHA256 ?? '');
}
