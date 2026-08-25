import type { Plan, PlanDestination } from "../../src/build/buildPlan.js";

interface Props {
  home: string;
  destination: PlanDestination;
  ride: Plan["rides"][string] | null;
  onClose: () => void;
}

export function TripDetail({ home, destination, ride, onClose }: Props) {
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
            <span className="leg-time">
              {leg.departure} – {leg.arrival}
            </span>
            <span className="leg-where">
              {leg.from} → {leg.to}
            </span>
            <span className="leg-route">
              {[leg.route, leg.towards && `towards ${leg.towards}`, leg.trainNumber && `train ${leg.trainNumber}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ol>

      <h3>Ride back to {home}</h3>
      {!ride ? (
        <p className="detail-note">No cycling route was found for this station.</p>
      ) : (
        <>
          <p className="detail-summary">
            {Math.round(ride.km)} km · +{ride.ascentMetres} m · about{" "}
            {ride.ridingHours.toFixed(1)} h riding
            {ride.days > 1 && ` · ${ride.days} days`}
          </p>
          {ride.days > 1 && (
            <ol className="stages">
              {ride.stages.map((stage) => (
                <li key={stage.day}>
                  <span className="stage-day">Day {stage.day}</span>
                  <span className="stage-figures">
                    {Math.round(stage.km)} km · +{stage.ascentMetres} m
                  </span>
                  <span className="stage-stop">
                    {stage.day === ride.days
                      ? `arrive ${home}`
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
    </section>
  );
}
