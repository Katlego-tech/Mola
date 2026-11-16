import { Button } from '@/components/ui/button';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { Board } from '@/lib/messages';

function useQr(text: string | null): string | null {
  const [image, setImage] = useState<{ text: string; src: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (text === null) return;
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 512, color: { dark: '#1b1530', light: '#fdfcfe' } })
      .then((url) => live && setImage({ text, src: url }))
      .catch(() => live && setImage(null));
    return () => {
      live = false;
    };
  }, [text]);
  return image?.text === text ? image.src : null;
}

export function SidePanel({ board, joinUrl, onUnlock }: { board: Board; joinUrl: string | null; onUnlock?(): void }) {
  const qr = useQr(joinUrl);
  return (
    <aside className="grid grid-rows-[auto_auto_1fr_auto] gap-[3vh] bg-ticket px-[3vw] py-[5vh] text-ink">
      <h2 className="text-[4.4vh] leading-[1.05] font-bold">{joinUrl ? 'Scan to get a number' : 'Unlock this screen to show the join code'}</h2>
      <div className="grid size-[34vh] place-items-center rounded-[14px] bg-[#fdfcfe] p-[2.4vh]">
        {!joinUrl && <Button variant="ticket" onClick={onUnlock}>Unlock</Button>}
        {qr && <img src={qr} alt="QR code to join the queue" className="size-full" />}
      </div>
      <div className="self-end">
        <span className="m-ln num text-[14vh]">
          <span key={board.waitingCount}>{board.waitingCount}</span>
        </span>
        <p className="mt-[1vh] text-[2.6vh] font-bold">{board.waitingCount === 1 ? 'person' : 'people'} waiting</p>
      </div>
      {board.upNext.length > 0 && (
        <div className="border-t-2 border-dashed border-ticket-deep pt-[2.2vh]">
          <p className="mb-[1.2vh] text-[2.2vh] font-bold">Up next</p>
          <ol className="flex gap-[2.2vw] font-mono text-[4vh] font-bold">
            {board.upNext.map((n) => (
              <li key={n} className="m-shift">{n}</li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}
