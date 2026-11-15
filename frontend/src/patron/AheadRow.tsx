import { aheadLabel, ordinal } from '@/lib/format';

const MAX_MARKS = 12;

/** "N people ahead" with one mark per real person in the line, and a ring for "you" (web.md 6.2). */
export function AheadRow({ position }: { position: number }) {
  const ahead = position - 1;
  const marks = Math.min(ahead, MAX_MARKS);
  return (
    <>
      <p className="text-[1.75rem] leading-[1.1] font-bold">
        <span className="m-ln inline-block align-bottom">
          <span key={position}>{aheadLabel(position)}</span>
        </span>
        <small className="mt-1.5 block text-[1.0625rem] font-normal">You're {ordinal(position)} in line.</small>
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-1.5" aria-hidden>
        {Array.from({ length: marks }, (_, i) => (
          <i key={i} className="size-3.5 rounded-full bg-ink/80" />
        ))}
        {ahead > MAX_MARKS && <span className="text-[0.875rem] font-bold">+{ahead - MAX_MARKS}</span>}
        <i className="size-3.5 rounded-full border-[2.5px] border-ink" />
        <span className="ml-1 text-[0.875rem] font-bold">you</span>
      </div>
    </>
  );
}
