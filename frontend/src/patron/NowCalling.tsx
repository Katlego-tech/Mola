import type { Board } from '@/lib/messages';

export function NowCalling({ calling }: { calling: Board['calling'] }) {
  if (calling.length === 0) return null;
  const parts = calling.map((c) => `${c.ticketNo} at ${c.desk}`);
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3.5 gap-y-1 px-1">
      <dt className="text-[0.875rem] font-semibold text-muted">Now calling</dt>
      <dd className="font-bold">{text}</dd>
    </dl>
  );
}
