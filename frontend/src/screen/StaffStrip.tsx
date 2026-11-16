import { ChartBar, MegaphoneSimple, NotePencil } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

/** One control strip under the board, never covering the numbers (screen-staff.png). */
export function StaffStrip({ desk, onDesk, onCallNext, onNotes, onSummary, pending, log }: {
  desk: string;
  onDesk(desk: string): void;
  onCallNext(): void;
  onNotes(): void;
  onSummary(): void;
  pending: boolean;
  log: string | null;
}) {
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-[1vw] gap-y-[1vh] rounded-[14px] bg-surface px-[1.6vw] py-[1.8vh]">
      <label htmlFor="desk" className="text-[2vh] font-bold text-muted">This desk</label>
      <input
        id="desk"
        value={desk}
        maxLength={20}
        disabled={pending}
        onChange={(e) => onDesk(e.target.value)}
        className="w-[12ch] rounded-[14px] border-2 border-muted bg-ground px-[0.9vw] py-[1.2vh] text-[2.4vh] font-bold text-text"
      />
      <div />
      <button onClick={onNotes} className="inline-flex items-center gap-[0.5vw] rounded-[14px] border-2 border-line px-[1vw] py-[1.5vh] text-[2vh] font-bold whitespace-nowrap"><NotePencil weight="bold" aria-hidden />Office notes</button>
      <button onClick={onSummary} className="inline-flex items-center gap-[0.5vw] rounded-[14px] border-2 border-line px-[1vw] py-[1.5vh] text-[2vh] font-bold whitespace-nowrap"><ChartBar weight="bold" aria-hidden />Day summary</button>
      <Button variant="ticket" onClick={onCallNext} disabled={pending} className="px-[1.8vw] py-[2vh] text-[3vh]">
        <MegaphoneSimple weight="bold" aria-hidden />
        Call next
      </Button>
      <span className="col-span-full row-start-2 truncate text-[2vh] text-muted" role="status">{log}</span>
    </div>
  );
}
