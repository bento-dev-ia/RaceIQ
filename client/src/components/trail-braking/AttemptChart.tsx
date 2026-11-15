import { useMemo, useState } from "react";
import type { IdealPoint, Sample } from "@/lib/trail-braking/sim";
import { m } from "@/paraglide/messages";

/** Validated pair (dark surface): you = blue, ideal = amber + dashed (secondary encoding). */
const YOU = "var(--trail-you)";
const IDEAL = "var(--trail-ideal)";

interface Props {
  samples: readonly Sample[];
  ideal: readonly IdealPoint[];
  fromM: number;
  toM: number;
  /** Add the gear panel (manual gearbox). */
  showGear?: boolean;
}

interface PanelProps extends Props {
  title: string;
  /** Value range of the panel. */
  min: number;
  max: number;
  you: (s: Sample) => number;
  idealOf: (p: IdealPoint) => number;
  format: (v: number) => string;
  hoverM: number | null;
  onHover: (m: number | null) => void;
}

const W = 520;
const H = 120;
const PAD = { l: 36, r: 8, t: 8, b: 18 };

function Panel({ samples, ideal, fromM, toM, title, min, max, you, idealOf, format, hoverM, onHover }: PanelProps) {
  const x = (s: number) => PAD.l + ((s - fromM) / (toM - fromM)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const yourPts = samples.filter((s) => s.s >= fromM && s.s <= toM);
  const idealPts = ideal.filter((p) => p.s >= fromM && p.s <= toM);
  const path = (pts: { s: number; v: number }[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.s).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const hoverYou = hoverM === null ? undefined : yourPts.reduce<Sample | undefined>((best, s) => (!best || Math.abs(s.s - hoverM) < Math.abs(best.s - hoverM) ? s : best), undefined);
  const hoverIdeal = hoverM === null ? undefined : idealPts.reduce<IdealPoint | undefined>((best, p) => (!best || Math.abs(p.s - hoverM) < Math.abs(best.s - hoverM) ? p : best), undefined);
  const ticks = [min, (min + max) / 2, max];

  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-medium text-app-text-secondary">{title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        role="img"
        aria-label={title}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          onHover(px < PAD.l || px > W - PAD.r ? null : fromM + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (toM - fromM));
        }}
        onPointerLeave={() => onHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--app-border)" strokeWidth={1} />
            <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--app-text-muted)">{format(t)}</text>
          </g>
        ))}
        <path d={path(idealPts.map((p) => ({ s: p.s, v: idealOf(p) })))} fill="none" stroke={IDEAL} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
        <path d={path(yourPts.map((s) => ({ s: s.s, v: you(s) })))} fill="none" stroke={YOU} strokeWidth={2} strokeLinejoin="round" />
        {hoverM !== null && (
          <g pointerEvents="none">
            <line x1={x(hoverM)} x2={x(hoverM)} y1={PAD.t} y2={H - PAD.b} stroke="var(--app-text-muted)" strokeWidth={1} />
            {hoverYou && <circle cx={x(hoverYou.s)} cy={y(you(hoverYou))} r={4} fill={YOU} stroke="var(--app-surface)" strokeWidth={2} />}
            {hoverIdeal && <circle cx={x(hoverIdeal.s)} cy={y(idealOf(hoverIdeal))} r={4} fill={IDEAL} stroke="var(--app-surface)" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {hoverM !== null && (
        <div className="mt-1 flex gap-4 text-xs text-app-text-secondary" aria-live="polite">
          <span>{Math.round(hoverM)} m</span>
          {hoverYou && <span><span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: YOU }} />{m.trail_you()}: {format(you(hoverYou))}</span>}
          {hoverIdeal && <span><span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: IDEAL }} />{m.trail_ideal()}: {format(idealOf(hoverIdeal))}</span>}
        </div>
      )}
    </figure>
  );
}

/** Brake and steering against distance — you vs ideal — as two small multiples sharing the hover. */
export function AttemptChart(props: Props) {
  const [hoverM, setHoverM] = useState<number | null>(null);
  const steerRange = useMemo(() => {
    const peak = Math.max(0.1, ...props.samples.map((s) => Math.abs(s.steer)), ...props.ideal.map((p) => Math.abs(p.steer)));
    return Math.min(1, Math.ceil(peak * 10) / 10);
  }, [props.samples, props.ideal]);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-4 text-xs text-app-text-secondary">
        <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={YOU} strokeWidth="2" /></svg>{m.trail_you()}</span>
        <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={IDEAL} strokeWidth="2" strokeDasharray="5 4" /></svg>{m.trail_ideal()}</span>
      </div>
      <Panel {...props} title={m.trail_chart_brake()} min={0} max={1} you={(s) => s.brake} idealOf={(p) => p.brake} format={pct} hoverM={hoverM} onHover={setHoverM} />
      <Panel {...props} title={m.trail_chart_steer()} min={-steerRange} max={steerRange} you={(s) => s.steer} idealOf={(p) => p.steer} format={pct} hoverM={hoverM} onHover={setHoverM} />
      {props.showGear && (
        <Panel {...props} title={m.trail_chart_gear()} min={1} max={6} you={(s) => s.gear} idealOf={(p) => p.gear} format={(v) => `${Math.round(v)}ª`} hoverM={hoverM} onHover={setHoverM} />
      )}
    </div>
  );
}
