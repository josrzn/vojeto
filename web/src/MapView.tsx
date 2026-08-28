import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { Plan, PlanDestination, PlanRideVariant } from "../../src/build/buildPlan.js";
import type { Home } from "./explore.js";
import type { Point } from "../../src/shared/geo.js";

import { contourFeatures } from "../../src/bike/contour.js";
import { MAP_GRADE_COLORS, bandSeries, type LoadedProfile } from "./grade.js";

interface Props {
  plan: Plan;
  destinations: PlanDestination[];
  selected: string | null;
  /** The way home currently being shown, or null when nothing is selected. */
  variant: PlanRideVariant | null;
  /**
   * Riding hours left after the selected station's train, i.e. the contour of
   * the ride field that is that station's personal frontier.
   */
  frontierHours: number | null;
  showField: boolean;
  showNoTrain: boolean;
  /** Elevation samples for the shown ride, once fetched. */
  profile: LoadedProfile | null;
  /** Sample the reader is hovering in the profile chart, echoed on the map. */
  hoverIndex: number | null;
  /** Where you start and finish, which the picker can move. */
  home: Home;
  /** Waiting for a click to place the ride-to point. */
  placing: boolean;
  onSelect: (stationId: string | null) => void;
  /** A map click while placing, in [lon, lat]. */
  onPlace: (at: Point) => void;
}

const FIELD_SOURCE = "ride-field";
const TRAIN_SOURCE = "train";
const NOTRAIN_SOURCE = "no-train";
const FRONTIER_SOURCE = "frontier";
const HOVER_SOURCE = "route-hover";
const STATIONS_SOURCE = "stations";
const ROUTE_SOURCE = "route";
const STAGES_SOURCE = "stages";

export function MapView({
  plan,
  destinations,
  selected,
  home,
  placing,
  onPlace,
  variant,
  frontierHours,
  showField,
  showNoTrain,
  profile,
  hoverIndex,
  onSelect,
}: Props) {
  // Contours are derived in the browser rather than baked into plan.json, so
  // the frontier can follow the selection without another build.
  const fieldLines = useMemo(() => {
    if (!plan.field) return null;
    const top = Math.ceil(plan.settings.budgetHours);
    const levels: number[] = [];
    for (let hours = 2; hours <= top; hours += 2) levels.push(hours);
    return contourFeatures(plan.field, levels);
  }, [plan.field, plan.settings.budgetHours]);

  const selectedLegs = useMemo(
    () => destinations.find((d) => d.stationId === selected)?.legs ?? null,
    [destinations, selected],
  );

  const fieldBounds = useMemo((): [[number, number], [number, number]] | null => {
    const grid = plan.field;
    if (!grid) return null;
    const known = grid.values
      .map((value, i) => (value === null ? null : i))
      .filter((i): i is number => i !== null);
    if (known.length === 0) return null;
    const lons = known.map((i) => grid.west + (i % grid.cols) * grid.lonStep);
    const lats = known.map((i) => grid.south + Math.floor(i / grid.cols) * grid.latStep);
    return [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
  }, [plan.field]);

  const frontierLines = useMemo(() => {
    if (!plan.field || frontierHours === null || frontierHours <= 0) return null;
    return contourFeatures(plan.field, [frontierHours])[0] ?? null;
  }, [plan.field, frontierHours]);

  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  /**
   * State, not a ref: the map is built inside an async effect, so the layer
   * effects below run before it exists. Without a state change to bring them
   * back they would only ever repaint by luck, when some other dependency
   * happened to be freshly allocated.
   */
  const [ready, setReady] = useState(false);
  // The click handler is registered once, so it reads the current callback here
  // rather than closing over a stale one.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // The map's listeners are attached once, when the style loads, so they read
  // these rather than closing over a render's values.
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const placingRef = useRef(placing);
  placingRef.current = placing;

  useEffect(() => {
    if (!container.current || map.current) return;
    let cancelled = false;
    let instance: MapLibreMap | null = null;

    void (async () => {
      const style = await resolveStyle(plan.settings.mapStyleUrl);
      if (cancelled || !container.current) return;

      instance = new maplibregl.Map({
        container: container.current,
        style: style.spec,
        center: [plan.home.rideTo.lon, plan.home.rideTo.lat],
        zoom: 7,
        attributionControl: { compact: true },
      });
      map.current = instance;
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      instance.on("load", () => {
        if (!instance) return;
        // Frame the whole ride-time field on opening: its extent is the area
        // the trip could possibly cover, which is what you want to see first.
        if (fieldBounds) {
          instance.fitBounds(fieldBounds, { padding: 60, duration: 0 });
        }
        instance.addSource(FIELD_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(FRONTIER_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(TRAIN_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(NOTRAIN_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(ROUTE_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(HOVER_SOURCE, { type: "geojson", data: emptyCollection() });

        // Drawn first, so the field stays a backdrop and never competes with
        // the stations, which are the only places you can actually start.
        // A white casing under the contour, so it reads over a detailed
        // basemap instead of disappearing into the roads.
        instance.addLayer({
          id: "field-casing",
          type: "line",
          source: FIELD_SOURCE,
          paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": 0.65 },
        });
        instance.addLayer({
          id: "field-lines",
          type: "line",
          source: FIELD_SOURCE,
          paint: {
            "line-color": "#2f6b5b",
            "line-width": ["interpolate", ["linear"], ["get", "level"], 2, 1.2, 12, 2.4],
            "line-opacity": 0.9,
          },
        });
        instance.addLayer({
          id: "frontier-line",
          type: "line",
          source: FRONTIER_SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            // Neutral: a budget line, and it must not read as the train.
            "line-color": "#52514e",
            "line-width": 3,
            "line-opacity": 0.95,
            "line-dasharray": [2, 1.5],
          },
        });
        instance.addSource(STATIONS_SOURCE, { type: "geojson", data: emptyCollection() });
        instance.addSource(STAGES_SOURCE, { type: "geojson", data: emptyCollection() });

        // Stations the rail network serves but no morning train reaches: hollow,
        // so they read as absences rather than as options.
        instance.addLayer({
          id: "no-train-dots",
          type: "circle",
          source: NOTRAIN_SOURCE,
          paint: {
            "circle-radius": 3.5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#93a1b0",
            "circle-stroke-width": 1.5,
            "circle-opacity": 0.9,
          },
        });

        instance.addLayer({
          id: "train-line",
          type: "line",
          source: TRAIN_SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            // The train is the cool half of the map; the bike and its gradient
            // ramp are the warm half.
            "line-color": "#2a78d6",
            "line-width": 3,
            "line-opacity": 0.9,
          },
        });
        instance.addLayer({
          id: "train-change",
          type: "circle",
          source: TRAIN_SOURCE,
          filter: ["==", ["get", "change"], true],
          paint: {
            "circle-radius": 7,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#2a78d6",
            "circle-stroke-width": 3,
          },
        });
        instance.addLayer({
          id: "train-calls",
          type: "circle",
          source: TRAIN_SOURCE,
          filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "change"], true]],
          paint: {
            "circle-radius": 3,
            "circle-color": "#2a78d6",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
          },
        });

        instance.addLayer({
          id: "route-casing",
          type: "line",
          source: ROUTE_SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 },
        });
        instance.addLayer({
          id: "route-line",
          type: "line",
          source: ROUTE_SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            // Falls back to the ride's own colour until the elevation arrives.
            "line-color": ["coalesce", ["get", "color"], "#cc373f"],
            "line-width": 3.5,
          },
        });
        instance.addLayer({
          id: "route-hover",
          type: "circle",
          source: HOVER_SOURCE,
          paint: {
            "circle-radius": 6,
            "circle-color": "#811d22",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2.5,
          },
        });

        instance.addLayer({
          id: "stage-stops",
          type: "circle",
          source: STAGES_SOURCE,
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#cc373f",
            "circle-stroke-width": 2.5,
          },
        });

        instance.addLayer({
          id: "station-dots",
          type: "circle",
          source: STATIONS_SOURCE,
          paint: {
            "circle-radius": ["case", ["get", "isHome"], 7, ["get", "isSelected"], 8, 5],
            "circle-color": [
              "case",
              // Home is an anchor rather than a series, so it wears ink; the
              // aqua for stations clears the chroma floor that the old
              // desaturated green did not.
              ["get", "isHome"], "#0b0b0b",
              ["get", "isSelected"], "#cc373f",
              "#1baf7a",
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });

        // Symbol layers need a glyph endpoint, which the offline fallback style
        // has no way to provide, so labels are added only when one exists.
        if (style.hasGlyphs) {
          instance.addLayer({
            id: "field-labels",
            type: "symbol",
            source: FIELD_SOURCE,
            layout: {
              "symbol-placement": "line",
              "text-field": ["concat", ["to-string", ["get", "level"]], "h"],
              "text-size": 11,
              "symbol-spacing": 220,
            },
            paint: {
              "text-color": "#3d6b5e",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.6,
            },
          });
          instance.addLayer({
            id: "train-change-labels",
            type: "symbol",
            source: TRAIN_SOURCE,
            filter: ["==", ["get", "change"], true],
            layout: {
              "text-field": ["get", "label"],
              "text-size": 11,
              "text-offset": [0, -1.4],
              "text-anchor": "bottom",
              "text-allow-overlap": true,
            },
            paint: { "text-color": "#2a78d6", "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
          });
          instance.addLayer({
            id: "stage-labels",
            type: "symbol",
            source: STAGES_SOURCE,
            layout: {
              "text-field": ["get", "label"],
              "text-size": 11,
              "text-offset": [0, 1.3],
              "text-anchor": "top",
            },
            paint: { "text-color": "#8a2f3d", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
          });
          instance.addLayer({
            id: "station-labels",
            type: "symbol",
            source: STATIONS_SOURCE,
            layout: {
              "text-field": ["get", "name"],
              "text-size": 12,
              "text-offset": [0, 1.1],
              "text-anchor": "top",
              "text-allow-overlap": false,
            },
            paint: { "text-color": "#22303c", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
          });
        }

        instance.on("click", "station-dots", (event) => {
          // While placing, a click anywhere means "here" — including on a
          // station dot, which is often exactly where someone aims.
          if (placingRef.current) return;
          const stationId = event.features?.[0]?.properties?.["stationId"];
          if (typeof stationId === "string") onSelectRef.current(stationId);
        });

        instance.on("click", (event) => {
          if (!placingRef.current) return;
          onPlaceRef.current({ lat: event.lngLat.lat, lon: event.lngLat.lng });
        });
        for (const layer of ["station-dots", "stage-stops"]) {
          instance.on("mouseenter", layer, () => {
            instance?.getCanvas().style.setProperty("cursor", "pointer");
          });
          instance.on("mouseleave", layer, () => {
            instance?.getCanvas().style.removeProperty("cursor");
          });
        }

        setReady(true);
      });
    })();

    return () => {
      cancelled = true;
      setReady(false);
      instance?.remove();
      map.current = null;
    };
    // fieldBounds is only read when the map is first built; it is derived from
    // plan.field, which does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.settings.mapStyleUrl, plan.home.rideTo.lat, plan.home.rideTo.lon]);

  // Station markers for the current month.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const paint = () => {
      const source = instance.getSource(STATIONS_SOURCE) as GeoJSONSource | undefined;
      if (!source) return;
      source.setData({
        type: "FeatureCollection",
        features: [
          point(home.rideTo.lon, home.rideTo.lat, {
            stationId: "",
            name: "Home",
            isHome: true,
            isSelected: false,
          }),
          point(home.at.lon, home.at.lat, {
            stationId: home.stationId,
            name: home.name,
            isHome: false,
            isSelected: false,
          }),
          ...destinations.map((destination) =>
            point(destination.lon, destination.lat, {
              stationId: destination.stationId,
              name: destination.name,
              isHome: false,
              isSelected: destination.stationId === selected,
            }),
          ),
        ],
      });
    };

    paint();
  }, [ready, home, destinations, selected]);

  // The continuous ride-time-home backdrop.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const paint = () => {
      const source = instance.getSource(FIELD_SOURCE) as GeoJSONSource | undefined;
      if (!source) return;
      source.setData({
        type: "FeatureCollection",
        features:
          showField && fieldLines
            ? fieldLines.map((contour) => ({
                type: "Feature" as const,
                properties: { level: contour.level },
                geometry: { type: "MultiLineString" as const, coordinates: contour.coordinates },
              }))
            : [],
      });
    };
    paint();
  }, [ready, fieldLines, showField]);

  // The selected station's own frontier: how far out you could still ride home
  // from, once that station's train has been paid for.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const paint = () => {
      const source = instance.getSource(FRONTIER_SOURCE) as GeoJSONSource | undefined;
      if (!source) return;
      source.setData({
        type: "FeatureCollection",
        features:
          showField && frontierLines
            ? [
                {
                  type: "Feature" as const,
                  properties: { level: frontierLines.level },
                  geometry: {
                    type: "MultiLineString" as const,
                    coordinates: frontierLines.coordinates,
                  },
                },
              ]
            : [],
      });
    };
    paint();
  }, [ready, frontierLines, showField]);

  // Stations the trains never reach in time.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(NOTRAIN_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: "FeatureCollection",
      features: showNoTrain
        ? plan.noTrain.map((station) =>
            point(station.lon, station.lat, { name: station.name }),
          )
        : [],
    });
  }, [ready, plan.noTrain, showNoTrain]);

  // The journey out, drawn through the stops the train calls at.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(TRAIN_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;

    const legs = selectedLegs ?? [];
    source.setData({
      type: "FeatureCollection",
      features: [
        ...legs
          .filter((leg) => leg.path.length > 1)
          .map((leg) => ({
            type: "Feature" as const,
            properties: {},
            geometry: { type: "LineString" as const, coordinates: leg.path },
          })),
        // Where one leg ends and the next begins: the change, which is the one
        // stop on the journey you actually have to do something at.
        ...legs.flatMap((leg, i) =>
          leg.path.map((c, j) => {
            const isChange = i > 0 && j === 0;
            return point(c[0]!, c[1]!, {
              change: isChange,
              ...(isChange ? { label: `change · ${leg.waitMinutes} min` } : {}),
            });
          }),
        ),
      ],
    });
  }, [ready, selectedLegs]);

  // Where the reader is pointing in the elevation chart.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(HOVER_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const at = hoverIndex === null ? null : profile?.at[hoverIndex];
    source.setData({
      type: "FeatureCollection",
      features: at ? [point(at[0]!, at[1]!, {})] : [],
    });
  }, [ready, profile, hoverIndex]);

  // The ride home for whichever destination is selected.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const paint = () => {
      const routeSource = instance.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
      const stagesSource = instance.getSource(STAGES_SOURCE) as GeoJSONSource | undefined;
      if (!routeSource || !stagesSource) return;

      const ride = variant;
      if (!ride) {
        routeSource.setData(emptyCollection());
        stagesSource.setData(emptyCollection());
        return;
      }

      const bands = profile ? bandSeries(profile.grade) : null;
      routeSource.setData(
        profile && bands
          ? {
              type: "FeatureCollection",
              // One feature per band rather than per segment: five multi-line
              // features instead of several hundred single ones.
              features: MAP_GRADE_COLORS.map((color, band) => ({
                type: "Feature" as const,
                properties: { color, band },
                geometry: {
                  type: "MultiLineString" as const,
                  coordinates: profile.at
                    .slice(1)
                    .map((point, i) => [profile.at[i]!, point])
                    .filter((_, i) => (bands[i + 1] ?? 0) === band),
                },
              })).filter((f) => f.geometry.coordinates.length > 0),
            }
          : {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: ride.geometry },
                },
              ],
            },
      );

      stagesSource.setData({
        type: "FeatureCollection",
        features: ride.stages.slice(0, -1).map((stage) =>
          point(stage.end.lon, stage.end.lat, {
            label: stage.bailout
              ? `Night ${stage.day} · ${stage.bailout.name}`
              : `Night ${stage.day}`,
          }),
        ),
      });

      const bounds = ride.geometry.reduce(
        (box, [lon, lat]) => box.extend([lon!, lat!]),
        new maplibregl.LngLatBounds(
          [ride.geometry[0]![0]!, ride.geometry[0]![1]!],
          [ride.geometry[0]![0]!, ride.geometry[0]![1]!],
        ),
      );
      // Leave room for the detail panel, which sits over the left of the map.
      const wide = instance.getContainer().clientWidth > 820;
      instance.fitBounds(bounds, {
        padding: { top: 80, bottom: 80, right: 80, left: wide ? 420 : 40 },
        maxZoom: 11,
        duration: 700,
      });
    };

    paint();
  }, [ready, variant, profile]);

  return <div className="map" ref={container} />;
}

/** A flat grey backdrop, so the app still works when the tile host is unreachable. */
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#e8edf2" } }],
};

async function resolveStyle(
  url: string,
): Promise<{ spec: string | StyleSpecification; hasGlyphs: boolean }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(String(response.status));
    const spec = (await response.json()) as StyleSpecification;
    return { spec, hasGlyphs: Boolean(spec.glyphs) };
  } catch {
    console.warn(`Map style ${url} is unreachable; falling back to a plain background.`);
    return { spec: OFFLINE_STYLE, hasGlyphs: false };
  }
}

function point(lon: number, lat: number, properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } };
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
