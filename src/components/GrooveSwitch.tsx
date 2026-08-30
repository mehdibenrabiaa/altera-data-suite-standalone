// Dual-track groove toggle — small rectangular switch with a ridged thumb,
// used instead of antd's pill Switch wherever a compact on/off control is
// needed (Settings bar's SM/TAG, Properties panel's Adaptive toggle, etc.).
export default function GrooveSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`groove-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <div className="groove-switch-thumb" />
    </div>
  );
}
