import type { Budget } from "../../src/bike/effort.js";
import { formatHours } from "./corridors.js";

interface Props {
  budget: Budget;
  /** What the plan was built with, which is the ceiling on what can be shown. */
  built: Budget;
  onChange: (budget: Budget) => void;
  onClose: () => void;
}

/**
 * The budget, as something you can move rather than something you rebuild for.
 *
 * Everything here re-decides the map from data already loaded: how long a ride
 * takes does not depend on how much time you have, so changing the budget is
 * pure arithmetic over durations that are already known. No routing, no
 * timetable, no waiting.
 *
 * That is also the limit. A station beyond the budget the plan was built with
 * was never routed at all, so raising the budget past it cannot reveal anything
 * — it would only promise a longer list and not deliver one. The sliders stop
 * where the file stops, and say why.
 */
export function SettingsPanel({ budget, built, onChange, onClose }: Props) {
  const set = (patch: Partial<Budget>) => onChange({ ...budget, ...patch });

  return (
    <section className="settings" aria-label="Time budget">
      <header className="settings-head">
        <h3>Your day</h3>
        <button type="button" className="detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <Slider
        label="Whole outing"
        hint="train out and ride home together"
        value={budget.budgetHours}
        min={1}
        max={built.budgetHours}
        step={0.5}
        format={formatHours}
        onChange={(budgetHours) => set({ budgetHours })}
      />

      <Slider
        label="Shortest worth a ticket"
        hint="below this you could just have ridden there"
        value={budget.minHours}
        min={0}
        max={Math.max(1, built.budgetHours / 2)}
        step={0.5}
        format={formatHours}
        onChange={(minHours) => set({ minHours })}
      />

      <Slider
        label="Days"
        hint="more than one allows an overnight stop"
        value={budget.maxDays}
        min={1}
        max={Math.max(1, built.maxDays)}
        step={1}
        format={(v) => `${v}`}
        onChange={(maxDays) => set({ maxDays })}
      />

      {budget.maxDays > 1 && (
        <Slider
          label="Riding each later day"
          hint="after the first, which the train eats into"
          value={budget.hoursPerDay}
          min={1}
          max={Math.max(1, built.hoursPerDay)}
          step={0.5}
          format={formatHours}
          onChange={(hoursPerDay) => set({ hoursPerDay })}
        />
      )}

      <p className="settings-note">
        Recomputed from the rides already loaded — nothing is re-routed. The
        limits are what <code>npm run plan</code> built: stations further than a{" "}
        {formatHours(built.budgetHours)} day was never routed, so asking for more
        here could only show you a shorter list than the truth.
      </p>

      <button
        type="button"
        className="settings-reset"
        onClick={() => onChange(built)}
        disabled={
          budget.budgetHours === built.budgetHours &&
          budget.minHours === built.minHours &&
          budget.maxDays === built.maxDays &&
          budget.hoursPerDay === built.hoursPerDay
        }
      >
        Back to the plan's own settings
      </button>
    </section>
  );
}

interface SliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function Slider({ label, hint, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="setting">
      <span className="setting-label">
        {label}
        <strong>{format(value)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="setting-hint">{hint}</span>
    </label>
  );
}
