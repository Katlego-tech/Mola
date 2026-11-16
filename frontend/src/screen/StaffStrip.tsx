import { MegaphoneSimple } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

/** One control strip under the board, never covering the numbers (screen-staff.png). */
export function StaffStrip({ desk, onDesk, onCallNext, pending, log }: {
  desk: string;
  onDesk(desk: string): void;
  onCallNext(): void;
  pending: boolean;
  log: string | null;
}) {
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-[1.6vw] rounded-[14px] bg-surface px-[1.6vw] py-[1.8vh]">
      <label htmlFor="desk" className="text-[2vh] font-bold text-muted">This desk</label>
      <input
        id="desk"
        value={desk}
        maxLength={20}
        disabled={pending}
        onChange={(e) => onDesk(e.target.value)}
        className="w-[12ch] rounded-[14px] border-2 border-muted bg-ground px-[0.9vw] py-[1.2vh] text-[2.4vh] font-bold text-text"
      />
      <span className="truncate text-[2.2vh] text-muted" role="status">{log}</span>
      <Button variant="ticket" onClick={onCallNext} disabled={pending} className="px-[2.4vw] py-[2vh] text-[3vh]">
        <MegaphoneSimple weight="bold" aria-hidden />
        Call next
      </Button>
    </div>
  );
}
