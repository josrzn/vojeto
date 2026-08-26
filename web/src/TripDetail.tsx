import type { PlanDestination, PlanRideVariant } from "../../src/build/buildPlan.js";

import { formatHours } from "./corridors.js";

interface Props {
  destination: PlanDestination;
  variants: PlanRideVariant[];
  active: PlanRideVariant | null;
  onPickVariant: (id: string) => void;
  onClose: () => void;
}

export function TripDetail({ destination, variants, active, onPickVariant, onClose }: Props) {
  return (
    <section className="detail">
      <button type="button" className="detail-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <h2>{destination.name}</h2>
      <p className="detail-summary">
        {destination.departure} → {destination.arrival} · {destination.travel}
        {destination.transfers === 0
          ? " · direct"
          : ` · ${destination.transfers} change${destination.transfers > 1 ? "s" : ""}`}
      </p>

      <h3>Train out</h3>
      <ol className="legs">
        {destination.legs.map((leg, i) => (
          <li key={i}>
            {i > 0 && (
              <span className="leg-change">
                change at {leg.from} · {leg.waitMinutes} min
              </span>
            )}
            <span className="leg-time">
              {leg.departure} – {leg.arrival}
            </span>
            <span className="leg-where">
              {leg.from} → {leg.to}
            </span>
            <span className="leg-route">
              {[
                leg.route,
                leg.towards && `towards ${leg.towards}`,
                leg.trainNumber && `train ${leg.trainNumber}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ol>

      <h3>Ride home</h3>
      {variants.length === 0 ? (
        <p className="detail-note">No cycling route was found for this station.</p>
      ) : (
        <>
          <div className="variants" role="tablist">
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                role="tab"
                aria-selected={variant.id === active?.id}
                className={
                  [
                    "variant",
                    variant.id === active?.id ? "is-active" : "",
                    variant.feasible ? "" : "is-over",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
                onClick={() => onPickVariant(variant.id)}
                title={variant.feasible ? undefined : "Does not fit the time budget"}
              >
                <span className="variant-label">
                  {variant.label}
                  {variant.alternative > 0 && ` ${variant.alternative + 1}`}
                </span>
                <span className="variant-figures">
                  {Math.round(variant.km)} km · {formatHours(variant.hours)}
                </span>
              </button>
            ))}
          </div>

          {active && (
            <>
              <p className="detail-summary">
                {Math.round(active.km)} km · +{active.ascentMetres} m ·{" "}
                {formatHours(active.hours)} riding
                {active.days > 1 && ` · ${active.days} days`}
              </p>
              {active.gpx && (
                <p className="detail-export">
                  <a href={`./data/gpx/${active.gpx}`} download>
                    ↓ Download GPX
                  </a>{" "}
                  <span>full resolution, with elevation</span>
                </p>
              )}
              <p className={active.feasible ? "detail-slack" : "detail-note"}>
                {active.feasible
                  ? `${formatHours(Math.max(0, active.slackHours))} to spare`
                  : `${formatHours(Math.abs(active.slackHours))} over budget`}
                {" · BRouter reckons "}
                {formatHours(active.brouterHours)}
              </p>

              {active.days > 1 && (
                <ol className="stages">
                  {active.stages.map((stage) => (
                    <li key={stage.day}>
                      <span className="stage-day">Day {stage.day}</span>
                      <span className="stage-figures">
                        {Math.round(stage.km)} km · +{stage.ascentMetres} m ·{" "}
                        {formatHours(stage.hours)}
                      </span>
                      <span className="stage-stop">
                        {stage.day === active.days
                          ? "arrive home"
                          : stage.bailout
                            ? `stop near ${stage.bailout.name} (${stage.bailout.detourKm.toFixed(1)} km off route — train home from there if you have had enough)`
                            : "stop in open country, no station nearby"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
