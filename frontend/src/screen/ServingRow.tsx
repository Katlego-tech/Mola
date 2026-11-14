import type { Board } from '@/lib/messages';

export function ServingRow({ serving }: { serving: Board['serving'] }) {
  if (serving.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-[3vw]">
      <h2 className="text-[2.4vh] font-bold text-muted">Being served</h2>
      {serving.map((s) => (
        <span key={s.ticketNo} className="text-[3vh] font-semibold">
          <span className="font-mono font-bold">{s.ticketNo}</span> at {s.desk}
        </span>
      ))}
    </div>
  );
}
