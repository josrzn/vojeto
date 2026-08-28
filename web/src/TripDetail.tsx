import type { EffortModel } from "../../src/bike/effort.js";
import type { PlanDestination, PlanRideVariant } from "../../src/build/buildPlan.js";
import type { RouteStyle } from "./routeStyles.js";

import { formatHours } from "./corridors.js";
import { ElevationProfile } from "./ElevationProfile.js";
import type { LoadedProfile } from "./grade.js";

interface Props {
  destination: PlanDestination;
  variants: PlanRideVariant[];
  active: PlanRideVariant | null;
  profile: LoadedProfile | null;
  /** Passed through to the profile, which can plot against riding time. */
  effort: EffortModel;
  /** Where the .gpx can be had: a blob for a ride routed here, a file for one from the plan. */
  gpxUrl: string | null;
  gpxName: string;
  /** The style being fetched right now, or null when nothing is in flight. */
  routing: string | null;
  /** Why the last attempt failed, when it did. */
  error: string | null;
  /** Ways home not fetched yet, each one request away. */
  remaining: RouteStyle[];
  /** True when even the most direct way back is too short to be worth the fare. */
  tooShort: boolean;
  minHours: number;
  onRouteMore: (style: RouteStyle) => void;
  onHoverProfile: (index: number | null) => void;
  onPickVariant: (id: string) => void;
  onClose: () => void;
}

/**
 * The unsurfaced share of a ride, and how much of it is a guess.
 *
 * Said only when there is something to say: a ride that is all tarmac gets no
 * line at all rather than "0 km unpaved". Unrecorded surface is called out
 * separately because it is timed at road speed — if a route is half unrecorded,
 * its duration is an assumption and you should be told so rather than left to
 * infer it from a number that looks as solid as the others.
 */
function describeSurface(variant: PlanRideVariant) {
  const surfaceKm = variant.surfaceKm;
  if (!surfaceKm) return null;
  const parts: string[] = [];
  if (surfaceKm.unpaved >= 0.5) parts.push(`${Math.round(surfaceKm.unpaved)} km unpaved`);
  if (surfaceKm.unknown >= 0.5) {
    parts.push(`${Math.round(surfaceKm.unknown)} km unrecorded, timed as road`);
  }
  if (parts.length === 0) return null;
  return <p className="detail-surface">{parts.join(" · ")}</p>;
}

export function TripDetail({
  destination,
  variants,
  active,
  profile,
  effort,
  gpxUrl,
  gpxName,
  routing,
  error,
  remaining,
  tooShort,
  minHours,
  onRouteMore,
  onHoverProfile,
  onPickVariant,
  onClose,
}: Props) {
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
      {error && <p className="detail-error">{error}</p>}
      {variants.length === 0 ? (
        <p className="detail-note">
          {routing
            ? "Asking BRouter for a way home…"
            : error
              ? "Nothing routed from here yet — try again below."
              : "No cycling route home from here."}
        </p>
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
                  {variant.rank > 1 && ` ${variant.rank}`}
                </span>
                <span className="variant-figures">
                  {Math.round(variant.km)} km · {formatHours(variant.hours)}
                </span>
              </button>
            ))}
          </div>

          {tooShort && (
            <p className="detail-note">
              The shortest way back is under {formatHours(minHours)} — near enough
              to have simply ridden there.
            </p>
          )}

          {active && (
            <>
              <p className="detail-summary">
                {Math.round(active.km)} km · +{active.ascentMetres} m ·{" "}
                {formatHours(active.hours)} riding
                {active.days > 1 && ` · ${active.days} days`}
              </p>
              {describeSurface(active)}
              {profile && (
                <ElevationProfile
                  profile={profile}
                  effort={effort}
                  totalHours={active.hours}
                  onHover={onHoverProfile}
                />
              )}
              {gpxUrl && (
                <p className="detail-export">
                  <a href={gpxUrl} download={gpxName}>
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

      {(remaining.length > 0 || routing) && (
        <div className="more-ways">
          {remaining.map((style) => (
            <button
              key={style.id}
              type="button"
              className="variant is-ghost"
              disabled={routing !== null}
              onClick={() => onRouteMore(style)}
            >
              <span className="variant-label">{style.label}</span>
              <span className="variant-figures">
                {routing === style.id ? "asking BRouter…" : "+1 request"}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
