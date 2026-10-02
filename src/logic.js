// Pure logic for Safe Driving, extracted so it can be unit-tested without the
// browser-only SDK (see __tests__/logic.test.mjs). index.html does the fetching
// and the rendering; everything that DECIDES something is here.
//
// A trip is what the hub's `family.drives` key hands over: timings, distance,
// average and top speed, `speedBands` (seconds spent in each 10 km/h band,
// slowest first), a status, and events — hard_brake, hard_acceleration,
// phone_call and phone_unlocked. The hub holds no speed limit and makes no
// judgement; this file is where a limit is applied and a week is scored.

/** The hub's speed profile is in bands this wide (a wire contract). */
export const SPEED_BAND_KPH = 10;
export const KM_PER_MILE = 1.609344;

/** A trip counts toward the week unless someone has said it was not this
 *  member driving. An unmarked trip COUNTS: marking is the driver's job. */
export const COUNTED_STATUSES = ["driver", "unconfirmed"];
export const DISMISSED_STATUSES = ["passenger", "ignored"];

export function isCounted(trip) {
  return COUNTED_STATUSES.includes(trip?.status);
}

export function isDismissed(trip) {
  return DISMISSED_STATUSES.includes(trip?.status);
}

/**
 * An unlocked stretch that begins this soon after the trip does was already
 * under way when the drive started: the phone was unlocked before pulling
 * away — in a mount, showing directions — and nobody picked it up to unlock
 * it. (The phone stamps a stretch it finds already open with the trip's own
 * start time.)
 */
export const UNLOCK_AT_START_MS = 10_000;

/** Whether this unlocked stretch began with someone unlocking the phone while
 *  the car was being driven. */
export function isMidDriveUnlock(event, trip) {
  if (event?.type !== "phone_unlocked") return false;
  const at = Date.parse(event.at);
  const started = Date.parse(trip?.startedAt);
  if (Number.isNaN(at) || Number.isNaN(started)) return true;
  return at - started > UNLOCK_AT_START_MS;
}

/**
 * What happened on one trip, by kind. `unlocks` and `unlockedSeconds` are every
 * unlocked stretch; `midDriveUnlocks` is how many of them were someone
 * unlocking the phone during the drive. Only the last is treated as a problem:
 * a phone unlocked for the whole drive is a phone giving directions.
 */
export function eventCounts(trip) {
  const counts = {
    hardBrakes: 0, hardAccelerations: 0, calls: 0, callSeconds: 0,
    unlocks: 0, unlockedSeconds: 0, midDriveUnlocks: 0,
  };
  for (const event of trip?.events ?? []) {
    const seconds = Number.isFinite(event.durationS) ? Math.max(0, event.durationS) : 0;
    if (event.type === "hard_brake") counts.hardBrakes++;
    else if (event.type === "hard_acceleration") counts.hardAccelerations++;
    else if (event.type === "phone_call") { counts.calls++; counts.callSeconds += seconds; }
    else if (event.type === "phone_unlocked") {
      counts.unlocks++;
      counts.unlockedSeconds += seconds;
      if (isMidDriveUnlock(event, trip)) counts.midDriveUnlocks++;
    }
  }
  return counts;
}

/** Whether a trip has anything on it worth a second look. Used for the small
 *  marker on a dismissed trip: a ride marked "passenger" that had three hard
 *  brakes is still worth an adult knowing about. A phone that was simply
 *  unlocked from the start is not such a thing. */
export function hasEvents(trip) {
  const counts = eventCounts(trip);
  return counts.hardBrakes + counts.hardAccelerations + counts.calls + counts.midDriveUnlocks > 0;
}

/**
 * Seconds spent clearly over `limitKph`: the bands that lie wholly at or above
 * it. A band the limit falls inside is NOT counted — the profile cannot say how
 * much of it was over — so this understates rather than accuses. With a limit
 * of 105 km/h (65 mph), counting starts at 110.
 */
export function secondsOverLimit(speedBands, limitKph) {
  if (!Array.isArray(speedBands) || !Number.isFinite(limitKph) || limitKph <= 0) return 0;
  const firstBand = Math.ceil(limitKph / SPEED_BAND_KPH);
  let seconds = 0;
  for (let band = firstBand; band < speedBands.length; band++) {
    if (Number.isFinite(speedBands[band])) seconds += Math.max(0, speedBands[band]);
  }
  return seconds;
}

/** The Monday of the week a `yyyy-mm-dd` day falls in, as `yyyy-mm-dd`. Works
 *  on the calendar date alone, so no time zone can move it. */
export function weekStart(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString().slice(0, 10);
}

/** `day` moved by `days` (may be negative), as `yyyy-mm-dd`. */
export function addDays(day, days) {
  const [y, m, d] = String(day).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * One driver's week (or any set of their trips), totalled. Only trips that
 * count are totalled; the dismissed ones are numbered and left out.
 * `limitKph` is that driver's limit, or null when none is set.
 */
export function summarize(trips, limitKph = null) {
  const summary = {
    trips: 0, dismissed: 0, unconfirmed: 0,
    minutes: 0, nightMinutes: 0, distanceM: 0, maxSpeedKph: 0,
    hardBrakes: 0, hardAccelerations: 0,
    calls: 0, callSeconds: 0, unlocks: 0, unlockedSeconds: 0, midDriveUnlocks: 0,
    overLimitSeconds: 0, profiledSeconds: 0,
    limitKph: Number.isFinite(limitKph) && limitKph > 0 ? limitKph : null,
  };
  for (const trip of trips ?? []) {
    if (!isCounted(trip)) { summary.dismissed++; continue; }
    summary.trips++;
    if (trip.status === "unconfirmed") summary.unconfirmed++;
    summary.minutes += trip.minutes ?? 0;
    summary.nightMinutes += trip.nightMinutes ?? 0;
    summary.distanceM += trip.distanceM ?? 0;
    summary.maxSpeedKph = Math.max(summary.maxSpeedKph, trip.maxSpeedKph ?? 0);
    const counts = eventCounts(trip);
    for (const key of Object.keys(counts)) summary[key] += counts[key];
    if (Array.isArray(trip.speedBands)) {
      summary.profiledSeconds += trip.speedBands.reduce((sum, s) => sum + (Number.isFinite(s) ? Math.max(0, s) : 0), 0);
      if (summary.limitKph) summary.overLimitSeconds += secondsOverLimit(trip.speedBands, summary.limitKph);
    }
  }
  return summary;
}

/** Less driving than this in the period is too little to score fairly: one
 *  hard stop on a five-minute errand is not a pattern. */
export const MIN_SCORED_DISTANCE_M = 20_000;

/**
 * A score out of 100 for a summary, with what cost the points — or null when
 * there was too little driving to say.
 *
 * Every part is a RATE, so a long week is not punished for being long:
 *  - hard braking and acceleration, per 100 km      (up to 40 points)
 *  - share of the time spent clearly over the limit (up to 30; only with a limit set)
 *  - times the phone was unlocked mid-drive, per hour (up to 30; 5 points each)
 *
 * HOW LONG the phone was unlocked costs nothing. A phone unlocked for the whole
 * drive is one giving directions, and that is a fair use of it; what is scored
 * is picking it up and unlocking it while driving. Calls are shown but not
 * scored either: the phone cannot tell a hands-free call from one held to the
 * ear. The label on screen says "phone unlocked", never "phone used".
 */
export function scoreSummary(summary) {
  if (!summary || summary.distanceM < MIN_SCORED_DISTANCE_M) return null;
  const per100km = (summary.hardBrakes + summary.hardAccelerations) / (summary.distanceM / 100_000);
  const driveSeconds = Math.max(summary.minutes * 60, 1);
  const overShare = summary.limitKph && summary.profiledSeconds > 0
    ? summary.overLimitSeconds / summary.profiledSeconds
    : 0;
  const unlocksPerHour = summary.midDriveUnlocks / (driveSeconds / 3600);
  const parts = {
    hardEvents: Math.min(40, Math.round(per100km * 8)),
    overLimit: Math.min(30, Math.round(overShare * 150)),
    phoneUnlocks: Math.min(30, Math.round(unlocksPerHour * 5)),
  };
  return { score: Math.max(0, 100 - parts.hardEvents - parts.overLimit - parts.phoneUnlocks), parts };
}

/** Trips whose household-local day falls in the week starting `monday`.
 *  `dayOf(trip)` gives that day (index.html passes hubToday on startedAt). */
export function tripsInWeek(trips, monday, dayOf) {
  const end = addDays(monday, 7);
  return (trips ?? []).filter((trip) => {
    const day = dayOf(trip);
    return day >= monday && day < end;
  });
}

/** Trips grouped by day, newest day first, newest trip first within a day. */
export function groupByDay(trips, dayOf) {
  const groups = new Map();
  for (const trip of [...(trips ?? [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))) {
    const day = dayOf(trip);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(trip);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => ({ day, trips: list }));
}

/**
 * Who appears in the driver picker: every member with a trip the viewer was
 * handed, the viewer first. The hub has already decided whose trips those are
 * (a non-adult reads their own; a supervising adult reads the non-adults'; an
 * adult's own drives are theirs alone), so this never widens anything — it only
 * names what arrived.
 */
export function driversFrom(trips, members, meId, limitIds = []) {
  // …and every driver the viewer can read a limit for, so a limit can still be
  // seen and cleared in a month its driver did not drive.
  const known = new Set((members ?? []).map((member) => member.id));
  const ids = [...new Set([
    ...(trips ?? []).map((trip) => trip.memberId),
    ...[...limitIds].filter((id) => known.has(id)),
  ])];
  const name = (id) => (members ?? []).find((member) => member.id === id)?.name ?? "Member";
  return ids
    .map((id) => ({ id, name: id === meId ? "You" : name(id) }))
    .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Whether the viewer may mark this trip, mirroring the hub's rule so the
 * buttons shown are the ones that work: your own trips, and — for an adult — a
 * non-adult's. The hub decides for real (in a shared space only a steward
 * supervises); a refusal there is shown as a message, not hidden here.
 */
export function canMark(trip, me, members) {
  if (!trip || !me) return false;
  if (trip.memberId === me.id) return true;
  if (trip.selfOnly) return false;
  const driver = (members ?? []).find((member) => member.id === trip.memberId);
  return me.role === "adult" && driver?.role !== "adult";
}

/** Whether the viewer is OFFERED the speed limit for this driver: an adult,
 *  for a driver who is not one. A choice about what the screen shows, not a
 *  rule the hub enforces — the table lets any supervising adult write any row.
 *  An adult's own drives have no limit in this version. */
export function canSetLimit(driverId, me, members) {
  const driver = (members ?? []).find((member) => member.id === driverId);
  return me?.role === "adult" && !!driver && driver.role !== "adult";
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatDistance(meters, unit = "km") {
  const km = (meters ?? 0) / 1000;
  const value = unit === "mi" ? km / KM_PER_MILE : km;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

export function formatSpeed(kph, unit = "km") {
  const value = unit === "mi" ? (kph ?? 0) / KM_PER_MILE : (kph ?? 0);
  return `${Math.round(value)} ${unit === "mi" ? "mph" : "km/h"}`;
}

/** `1 h 5 min`, `23 min`, `45 s`. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The limit a person typed, in the unit on screen, as whole km/h — or null
 *  when it is not a usable limit. */
export function limitToKph(value, unit = "km") {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const kph = Math.round(unit === "mi" ? number * KM_PER_MILE : number);
  return kph >= 20 && kph <= 250 ? kph : null;
}

/** A stored km/h limit in the unit on screen, as a whole number. */
export function limitFromKph(kph, unit = "km") {
  return Math.round(unit === "mi" ? kph / KM_PER_MILE : kph);
}

/** Where a trip went, in words: place names when the phone had them. */
export function tripRoute(trip) {
  const from = trip?.start?.label;
  const to = trip?.end?.label;
  if (from && to) return `${from} → ${to}`;
  if (to) return `To ${to}`;
  if (from) return `From ${from}`;
  return "Drive";
}

export const STATUS_LABEL = {
  unconfirmed: "Not marked",
  driver: "Driving",
  passenger: "Passenger",
  ignored: "Not a drive",
};

export const EVENT_LABEL = {
  hard_brake: "Hard braking",
  hard_acceleration: "Hard acceleration",
  phone_call: "On a call",
  phone_unlocked: "Phone unlocked",
};

/** The speed profile as bars: one per band that has time in it, with the
 *  band's range in the unit on screen and whether it lies over the limit. */
export function speedProfile(speedBands, limitKph, unit = "km") {
  if (!Array.isArray(speedBands)) return [];
  const total = speedBands.reduce((sum, s) => sum + (Number.isFinite(s) ? Math.max(0, s) : 0), 0);
  if (total <= 0) return [];
  const firstOver = Number.isFinite(limitKph) && limitKph > 0 ? Math.ceil(limitKph / SPEED_BAND_KPH) : Infinity;
  const toUnit = (kph) => Math.round(unit === "mi" ? kph / KM_PER_MILE : kph);
  return speedBands
    .map((seconds, band) => ({
      band,
      seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
      label: `${toUnit(band * SPEED_BAND_KPH)}–${toUnit((band + 1) * SPEED_BAND_KPH)}`,
      over: band >= firstOver,
    }))
    .filter((bar) => bar.seconds > 0)
    .map((bar) => ({ ...bar, share: bar.seconds / total }));
}

// ── Demo data (no hub attached) ───────────────────────────────────────────────

/** A week of example trips ending today, so the app renders with no hub. */
export function demoTrips(nowMs = Date.now()) {
  const at = (daysAgo, hour, minutes) => {
    const start = new Date(nowMs - daysAgo * 86_400_000);
    start.setHours(hour, 0, 0, 0);
    return { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(), minutes };
  };
  const place = (lat, lng, label) => ({ lat, lng, ...(label ? { label } : {}) });
  const home = place(47.6062, -122.3321, "Home");
  const school = place(47.6553, -122.3035, "School");
  const base = { memberId: "demo-3", selfOnly: false, hasRoute: false, nightMinutes: 0, events: [] };
  return [
    { ...base, id: "demo-t1", ...at(0, 8, 18), distanceM: 9400, avgSpeedKph: 31, maxSpeedKph: 72, status: "unconfirmed",
      start: home, end: school, speedBands: [120, 90, 200, 260, 250, 110, 50],
      events: [{ type: "hard_brake", at: at(0, 8, 18).startedAt, value: 4.1 }] },
    { ...base, id: "demo-t2", ...at(1, 17, 26), distanceM: 21500, avgSpeedKph: 50, maxSpeedKph: 118, status: "driver",
      start: school, end: home, speedBands: [100, 60, 120, 180, 200, 160, 120, 100, 140, 160, 120, 100],
      // Unlocked ten minutes in — picked up while driving.
      events: [{ type: "phone_unlocked", at: new Date(Date.parse(at(1, 17, 26).startedAt) + 600_000).toISOString(), durationS: 40 }] },
    { ...base, id: "demo-t3", ...at(2, 21, 35), distanceM: 30200, avgSpeedKph: 52, maxSpeedKph: 104, nightMinutes: 35, status: "driver",
      start: home, end: place(47.4502, -122.3088, "Airport"), speedBands: [140, 80, 160, 200, 240, 200, 180, 200, 300, 260, 140],
      // Unlocked from the start (directions to the airport), and one call.
      events: [
        { type: "phone_unlocked", at: at(2, 21, 35).startedAt, durationS: 2100 },
        { type: "phone_call", at: at(2, 21, 35).startedAt, durationS: 180 },
      ] },
    { ...base, id: "demo-t4", ...at(3, 15, 22), distanceM: 12800, avgSpeedKph: 35, maxSpeedKph: 80, status: "passenger",
      statusReason: "Carpool — Jordan drove", start: school, end: home, speedBands: [200, 150, 250, 300, 220, 150, 50],
      events: [{ type: "hard_brake", at: at(3, 15, 22).startedAt, value: 3.8 }] },
  ];
}
