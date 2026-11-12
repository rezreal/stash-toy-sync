import { TCODE_PLAYER_NOTICE } from "../coexist.ts";
import { useTcodePlayerPresent } from "./useTcodePlayer.ts";

export function TcodePlayerNotice() {
  const present = useTcodePlayerPresent();
  if (!present) return null;
  return (
    <div className="toysync-attention" role="status">
      {TCODE_PLAYER_NOTICE}
    </div>
  );
}
