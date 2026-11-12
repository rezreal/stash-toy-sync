// Whether the old TCode Player plugin is on the page. Its script may load
// after ours, so this looks again a little later.
import { tcodePlayerPresent } from "../coexist.ts";

const RECHECK_MS = [500, 2000, 5000];

export function useTcodePlayerPresent(): boolean {
  const [present, setPresent] = React.useState(() => tcodePlayerPresent());
  React.useEffect(() => {
    if (present) return;
    const ids = RECHECK_MS.map((ms) => window.setTimeout(() => setPresent(tcodePlayerPresent()), ms));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [present]);
  return present;
}
