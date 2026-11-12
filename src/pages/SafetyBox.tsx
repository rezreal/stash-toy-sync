// The safety rules, shown prominently on the calibration page and in short
// on the devices page.

export function SafetyBox(props: { compact?: boolean }) {
  if (props.compact) {
    return (
      <div className="toysync-safety toysync-safety-compact" role="note" aria-label="Safety">
        <strong>E-stim safety:</strong> electrodes below the waist only, never across the chest or heart. Start low.
        Pause, Stop or switch the device off any time. Nothing is ever sent above a channel's hard max.
      </div>
    );
  }
  return (
    <div className="toysync-safety" role="note" aria-label="Safety">
      <h2 className="toysync-h2">Safety first</h2>
      <ul>
        <li>
          <strong>Below the waist only.</strong> Never place electrodes across the chest, near the heart, on the head or
          neck, or so that current could flow across the torso. Not with a pacemaker, heart condition, epilepsy or during
          pregnancy.
        </li>
        <li>
          <strong>Start low.</strong> Every step starts at the bottom and output ramps up gently while you hold the
          button. Raise the level a little at a time.
        </li>
        <li>
          <strong>Stop any time.</strong> Output only runs while you hold the button; letting go, leaving the page or
          switching tabs stops it. The Stop button, or the device's own power button, stops everything.
        </li>
        <li>Nothing is ever sent above the hard max you set here.</li>
      </ul>
    </div>
  );
}
