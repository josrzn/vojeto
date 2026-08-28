import { describeCurve, type SpeedCurves } from "../../src/bike/speed.js";
import type { RouteStyle } from "./routeStyles.js";
import type { DayType, Settings } from "./settings.js";
import { formatHours } from "./corridors.js";

interface Props {
  settings: Settings;
  /** The circle actually being drawn, which is the budget's when none is set. */
  radiusKm: number;
  /** How fast you ride, which is read from config rather than edited here. */
  curves: SpeedCurves;
  /** What the settings currently produce, so a change can be seen as it is made. */
  counts: { inside: number; beyond: number; querying: boolean };
  styles: RouteStyle[];
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

const DAY_TYPES: Array<{ id: DayType; label: string }> = [
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
  { id: "weekday", label: "Weekday" },
];

/**
 * The things about you that do not change from one look at the map to the next.
 *
 * Deliberately not the same panel as start-and-finish. Which station you leave
 * from and where you are riding back to is the question you are asking, and it
 * changes every few seconds; when you want to be off a train, how long a day
 * you want and how far it is worth looking are answers about you, and they hold
 * across every question you ask afterwards.
 *
 * Changing the train half asks the timetable again, which is a few milliseconds
 * in a worker. Changing the day half is pure arithmetic over rides already
 * fetched. Neither re-routes anything: how long a road takes does not depend on
 * how much time you have.
 */
export function SettingsPanel({
  settings,
  radiusKm,
  curves,
  counts,
  styles,
  onChange,
  onClose,
}: Props) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  return (
    <section className="settings" aria-label="Settings">
      <header className="settings-head">
        <h3>Settings</h3>
        <button type="button" className="detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {/* Kept at the top of the panel rather than left down in the list, so
          every slider here has a visible consequence while you are moving it. */}
      <p className="settings-count" aria-live="polite">
        {counts.querying
          ? "asking the timetable…"
          : `${counts.inside} station${counts.inside === 1 ? "" : "s"} inside ${radiusKm} km` +
            (counts.beyond > 0
              ? `, ${counts.beyond} the train reaches beyond it`
              : ", and none further out")}
      </p>

      <h4 className="settings-group">The train out</h4>

      <label className="setting">
        <span className="setting-label">
          Off the train by
          <strong>{settings.arriveBy}</strong>
        </span>
        <input
          type="time"
          value={settings.arriveBy}
          onChange={(event) => set({ arriveBy: event.target.value })}
        />
        <span className="setting-hint">the latest arrival that still leaves a day</span>
      </label>

      <label className="setting">
        <span className="setting-label">
          And not before
          <strong>{settings.arriveNoEarlierThan}</strong>
        </span>
        <input
          type="time"
          value={settings.arriveNoEarlierThan}
          onChange={(event) => set({ arriveNoEarlierThan: event.target.value })}
        />
        <span className="setting-hint">so a 5 a.m. arrival is not offered as a day out</span>
      </label>

      <Slider
        label="Changes"
        hint="each one is a platform and a wait"
        value={settings.maxTransfers}
        min={0}
        max={3}
        step={1}
        format={(v) => (v === 0 ? "direct only" : `up to ${v}`)}
        onChange={(maxTransfers) => set({ maxTransfers })}
      />

      <Slider
        label="Longest journey out"
        hint="past this the train is the day"
        value={settings.maxTravelMinutes}
        min={30}
        max={360}
        step={15}
        format={(v) => formatHours(v / 60)}
        onChange={(maxTravelMinutes) => set({ maxTravelMinutes })}
      />

      <div className="setting">
        <span className="setting-label">Which day</span>
        <div className="chips" role="group">
          {DAY_TYPES.map((day) => (
            <button
              key={day.id}
              type="button"
              className={day.id === settings.dayType ? "chip is-active" : "chip"}
              onClick={() => set({ dayType: day.id })}
            >
              {day.label}
            </button>
          ))}
        </div>
        <span className="setting-hint">trains run differently at the weekend</span>
      </div>

      <h4 className="settings-group">Your day</h4>

      <Slider
        label="Whole outing"
        hint="train out and ride home together"
        value={settings.budgetHours}
        min={2}
        max={16}
        step={0.5}
        format={formatHours}
        onChange={(budgetHours) => set({ budgetHours })}
      />

      <Slider
        label="Shortest worth a ticket"
        hint="below this you could just have ridden there"
        value={settings.minHours}
        min={0}
        max={8}
        step={0.5}
        format={formatHours}
        onChange={(minHours) => set({ minHours })}
      />

      <Slider
        label="Days"
        hint="more than one allows an overnight stop"
        value={settings.maxDays}
        min={1}
        max={4}
        step={1}
        format={(v) => `${v}`}
        onChange={(maxDays) => set({ maxDays })}
      />

      {settings.maxDays > 1 && (
        <Slider
          label="Riding each later day"
          hint="after the first, which the train eats into"
          value={settings.hoursPerDay}
          min={1}
          max={12}
          step={0.5}
          format={formatHours}
          onChange={(hoursPerDay) => set({ hoursPerDay })}
        />
      )}

      <h4 className="settings-group">The ride home</h4>

      <Slider
        label="Look this far around home"
        hint="a straight line, drawn before any road is looked at"
        value={settings.radiusKm ?? radiusKm}
        min={20}
        max={300}
        step={10}
        format={(v) => `${v} km`}
        onChange={(km) => set({ radiusKm: km })}
      />
      {settings.radiusKm === null ? (
        <span className="setting-hint">
          Reckoned from your day: what is left after the train, at your flat
          speed, less a third for hills and for roads not running straight. A
          guess, not a bound — what falls outside it is listed under the map.
        </span>
      ) : (
        <button type="button" className="settings-reset" onClick={() => set({ radiusKm: null })}>
          Back to what your day suggests
        </button>
      )}

      <div className="setting">
        <span className="setting-label">Offered first</span>
        <div className="chips" role="group">
          {styles.map((style) => (
            <button
              key={style.id}
              type="button"
              className={style.id === settings.style ? "chip is-active" : "chip"}
              onClick={() => set({ style: style.id })}
            >
              {style.label}
            </button>
          ))}
        </div>
        <span className="setting-hint">
          the one way home fetched when you pick a station; the others are a
          click away
        </span>
      </div>

      <p className="settings-note">
        Riding at {describeCurve(curves.paved)}. Speed against gradient and
        surface is the one thing set in <code>config/home.json</code> rather than
        here — it is a curve, not a number, and it is worth writing down once
        properly.
      </p>
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
        value={Math.min(Math.max(value, min), max)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="setting-hint">{hint}</span>
    </label>
  );
}
