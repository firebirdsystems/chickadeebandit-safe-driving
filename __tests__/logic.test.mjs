import { describe, it, expect } from "vitest";
import {
  addDays, canMark, canSetLimit, demoTrips, driversFrom, recordingNotice, NO_DRIVES_DAYS, eventCounts, formatDistance, formatDuration, formatSpeed,
  groupByDay, hasEvents, isCounted, isDismissed, isMidDriveUnlock, limitFromKph, limitToKph, scoreSummary, secondsOverLimit, shownEvents, isStoppedUnlock, UNLOCK_MOVING_KPH,
  speedProfile, summarize, tripRoute, tripsInWeek, weekStart, MIN_SCORED_DISTANCE_M,
} from "../src/logic.js";

const trip = (overrides = {}) => ({
  id: "t1", memberId: "teen", startedAt: "2026-10-01T15:00:00.000Z", endedAt: "2026-10-01T15:30:00.000Z",
  minutes: 30, nightMinutes: 0, distanceM: 25_000, avgSpeedKph: 50, maxSpeedKph: 96,
  // 5 min in town, 20 on a 90–100 road, 5 at 110–120.
  speedBands: [0, 0, 0, 300, 0, 0, 0, 0, 0, 1200, 0, 300],
  start: { lat: 47.6, lng: -122.3 }, end: { lat: 47.7, lng: -122.2 },
  status: "driver", events: [], selfOnly: false, hasRoute: true,
  ...overrides,
});

const MEMBERS = [
  { id: "mom", name: "Mom", role: "adult" },
  { id: "dad", name: "Dad", role: "adult" },
  { id: "teen", name: "Sam", role: "child" },
  { id: "kid", name: "Riley", role: "child" },
];

describe("which trips count", () => {
  it("counts a trip marked driving and one nobody has marked; leaves out the dismissed ones", () => {
    expect(isCounted(trip({ status: "driver" }))).toBe(true);
    // Marking is the driver's job: an unmarked trip counts until someone says otherwise.
    expect(isCounted(trip({ status: "unconfirmed" }))).toBe(true);
    for (const status of ["passenger", "ignored"]) {
      expect(isCounted(trip({ status }))).toBe(false);
      expect(isDismissed(trip({ status }))).toBe(true);
    }
    expect(isDismissed(trip({ status: "unconfirmed" }))).toBe(false);
  });
});

describe("eventCounts", () => {
  it("counts each kind, and adds up how long the phone events lasted", () => {
    const counts = eventCounts(trip({ events: [
      { type: "hard_brake", at: "x", value: 4 }, { type: "hard_brake", at: "x" },
      { type: "hard_acceleration", at: "x" },
      { type: "phone_call", at: "x", durationS: 90 },
      { type: "phone_unlocked", at: "x", durationS: 20 }, { type: "phone_unlocked", at: "x", durationS: 15 },
      { type: "something_new", at: "x", durationS: 999 },
    ] }));
    // "x" is no time at all: an unlock the app cannot place counts as mid-drive.
    expect(counts).toEqual({
      hardBrakes: 2, hardAccelerations: 1, calls: 1, callSeconds: 90, unlocks: 2, unlockedSeconds: 35, midDriveUnlocks: 2,
    });
  });

  it("tells a phone unlocked from the start from one unlocked while driving", () => {
    const t = trip({ events: [
      // Stamped at the trip's own start: already unlocked when the drive began.
      { type: "phone_unlocked", at: "2026-10-01T15:00:00.000Z", durationS: 1800 },
      { type: "phone_unlocked", at: "2026-10-01T15:00:08.000Z", durationS: 5 },
      // Twelve minutes in: someone picked it up.
      { type: "phone_unlocked", at: "2026-10-01T15:12:00.000Z", durationS: 20 },
    ] });
    expect(t.events.map((event) => isMidDriveUnlock(event, t))).toEqual([false, false, true]);
    expect(eventCounts(t)).toMatchObject({ unlocks: 3, unlockedSeconds: 1825, midDriveUnlocks: 1 });
    expect(isMidDriveUnlock({ type: "phone_call", at: "2026-10-01T15:12:00.000Z" }, t)).toBe(false);
  });

  it("leaves out an unlock made while the car was stopped, and keeps one with no speed reported", () => {
    const unlock = (minute, speedKph) => ({
      type: "phone_unlocked", at: `2026-10-01T15:${minute}:00.000Z`, durationS: 20,
      ...(speedKph === undefined ? {} : { speedKph }),
    });
    const t = trip({
      events: [unlock(20, 0), unlock(12, 7), unlock(14, UNLOCK_MOVING_KPH), unlock(16, 60), unlock(18, undefined)],
    });
    expect(t.events.map((event) => isStoppedUnlock(event, t))).toEqual([true, true, false, false, false]);
    expect(shownEvents(t).map((event) => event.at.slice(14, 16))).toEqual(["14", "16", "18"]);
    expect(eventCounts(t)).toMatchObject({ unlocks: 3, unlockedSeconds: 60, midDriveUnlocks: 3 });
    // Stopped unlocks alone are nothing worth a second look.
    expect(hasEvents(trip({ events: [unlock(20, 0)] }))).toBe(false);
    // A phone unlocked before pulling away is still "from the start", whatever the speed then.
    const fromStart = trip({ events: [{ type: "phone_unlocked", at: t.startedAt, durationS: 900, speedKph: 0 }] });
    expect(shownEvents(fromStart)).toHaveLength(1);
    expect(eventCounts(fromStart)).toMatchObject({ unlocks: 1, midDriveUnlocks: 0 });
  });

  it("does not flag a dismissed trip for a phone that was only unlocked from the start", () => {
    expect(hasEvents(trip({ events: [{ type: "phone_unlocked", at: "2026-10-01T15:00:00.000Z", durationS: 1800 }] }))).toBe(false);
    expect(hasEvents(trip({ events: [{ type: "phone_unlocked", at: "2026-10-01T15:12:00.000Z", durationS: 20 }] }))).toBe(true);
    expect(hasEvents(trip({ events: [{ type: "phone_call", at: "2026-10-01T15:12:00.000Z", durationS: 20 }] }))).toBe(true);
  });

  it("is all zeros for a trip with nothing on it", () => {
    expect(Object.values(eventCounts(trip())).every((n) => n === 0)).toBe(true);
    expect(hasEvents(trip())).toBe(false);
    expect(hasEvents(trip({ events: [{ type: "hard_brake", at: "x" }] }))).toBe(true);
  });
});

describe("secondsOverLimit", () => {
  const bands = trip().speedBands;
  it("counts only the bands wholly at or above the limit", () => {
    // Limit 100: the 110–120 band (300 s). The 90–100 band is under it.
    expect(secondsOverLimit(bands, 100)).toBe(300);
    // Limit 90: the 90–100 band starts AT the limit, so it counts too.
    expect(secondsOverLimit(bands, 90)).toBe(1500);
  });

  it("does not count a band the limit falls inside — it understates rather than accuses", () => {
    // 65 mph is 105 km/h, inside no band here; 95 falls inside 90–100.
    expect(secondsOverLimit(bands, 105)).toBe(300);
    expect(secondsOverLimit(bands, 95)).toBe(300);
  });

  it("is nothing without a limit or a profile", () => {
    expect(secondsOverLimit(bands, null)).toBe(0);
    expect(secondsOverLimit(bands, 0)).toBe(0);
    expect(secondsOverLimit(undefined, 100)).toBe(0);
    expect(secondsOverLimit(bands, 400)).toBe(0);
  });
});

describe("weeks", () => {
  it("starts a week on its Monday, whatever day is asked", () => {
    // 1 October 2026 is a Thursday.
    expect(weekStart("2026-10-01")).toBe("2026-09-28");
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday belongs to the week before it ends
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(weekStart("nope")).toBe("");
  });

  it("moves across a month and a year", () => {
    expect(addDays("2026-10-01", -7)).toBe("2026-09-24");
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
  });

  it("puts a trip in the week of its household-local day, not its UTC day", () => {
    // 03:00 UTC on Monday the 5th is Sunday evening the 4th on the west coast.
    const late = trip({ id: "late", startedAt: "2026-10-05T03:00:00.000Z" });
    const dayOf = (t) => (t.id === "late" ? "2026-10-04" : "2026-10-01");
    expect(tripsInWeek([late, trip()], "2026-09-28", dayOf).map((t) => t.id)).toEqual(["late", "t1"]);
    expect(tripsInWeek([late, trip()], "2026-10-05", dayOf)).toEqual([]);
  });
});

describe("summarize", () => {
  it("totals the trips that count and only numbers the dismissed ones", () => {
    const summary = summarize([
      trip({ nightMinutes: 10, events: [{ type: "hard_brake", at: "x" }, { type: "phone_unlocked", at: "x", durationS: 60 }] }),
      trip({ id: "t2", status: "unconfirmed", maxSpeedKph: 120 }),
      trip({ id: "t3", status: "passenger", distanceM: 90_000, events: [{ type: "hard_brake", at: "x" }] }),
    ], 100);
    expect(summary).toMatchObject({
      trips: 2, dismissed: 1, unconfirmed: 1, minutes: 60, nightMinutes: 10, distanceM: 50_000, maxSpeedKph: 120,
      hardBrakes: 1, unlocks: 1, unlockedSeconds: 60, midDriveUnlocks: 1, overLimitSeconds: 600, profiledSeconds: 3600, limitKph: 100,
    });
  });

  it("has no over-the-limit figure when no limit is set", () => {
    expect(summarize([trip()], null)).toMatchObject({ limitKph: null, overLimitSeconds: 0 });
    expect(summarize([trip()])).toMatchObject({ limitKph: null });
  });

  it("copes with a trip from a phone that sent no speed profile", () => {
    expect(summarize([trip({ speedBands: undefined })], 100)).toMatchObject({ trips: 1, overLimitSeconds: 0, profiledSeconds: 0 });
  });
});

describe("scoreSummary", () => {
  it("is 100 for a clean week", () => {
    expect(scoreSummary(summarize([trip({ speedBands: [0, 0, 0, 1800] })], 100))).toEqual({
      score: 100, parts: { hardEvents: 0, overLimit: 0, phoneUnlocks: 0 },
    });
  });

  it("will not score too little driving", () => {
    expect(scoreSummary(summarize([trip({ distanceM: MIN_SCORED_DISTANCE_M - 1, events: [{ type: "hard_brake", at: "x" }] })]))).toBeNull();
    expect(scoreSummary(summarize([]))).toBeNull();
  });

  it("takes points for hard events per distance, so a long week is not punished for being long", () => {
    const brakes = (n) => Array.from({ length: n }, () => ({ type: "hard_brake", at: "x" }));
    // 2 events in 25 km is 8 per 100 km.
    const short = scoreSummary(summarize([trip({ events: brakes(2) })]));
    // The same 2 events over 250 km is 0.8 per 100 km.
    const long = scoreSummary(summarize([trip({ distanceM: 250_000, events: brakes(2) })]));
    expect(short.parts.hardEvents).toBe(40);
    expect(long.parts.hardEvents).toBe(6);
    expect(long.score).toBeGreaterThan(short.score);
  });

  it("takes points for time over the limit only when a limit is set", () => {
    // 300 of 1800 s over 100 km/h.
    expect(scoreSummary(summarize([trip()], 100)).parts.overLimit).toBe(25);
    expect(scoreSummary(summarize([trip()], null)).parts.overLimit).toBe(0);
  });

  it("takes nothing for a phone unlocked the whole drive: directions are a fair use of it", () => {
    const navigating = trip({ events: [{ type: "phone_unlocked", at: "2026-10-01T15:00:00.000Z", durationS: 1800 }] });
    expect(scoreSummary(summarize([navigating]))).toEqual({
      score: 100, parts: { hardEvents: 0, overLimit: 0, phoneUnlocks: 0 },
    });
  });

  it("takes points for unlocking the phone while driving, by how often per hour, and none for calls", () => {
    const pickup = (minute) => ({ type: "phone_unlocked", at: `2026-10-01T15:${String(minute).padStart(2, "0")}:00.000Z`, durationS: 15 });
    // Twice in a half-hour drive is four an hour.
    expect(scoreSummary(summarize([trip({ events: [pickup(5), pickup(20)] })])).parts.phoneUnlocks).toBe(20);
    // The same two over three hours of driving is a different habit.
    const long = Array.from({ length: 5 }, (_, i) => trip({ id: `clean-${i}` }));
    expect(scoreSummary(summarize([trip({ events: [pickup(5), pickup(20)] }), ...long])).parts.phoneUnlocks).toBe(3);
    // How long it stayed unlocked afterwards changes nothing.
    const lingering = trip({ events: [{ ...pickup(5), durationS: 1200 }, pickup(20)] });
    expect(scoreSummary(summarize([lingering])).parts.phoneUnlocks).toBe(20);
    // A call may be hands-free; the phone cannot tell.
    const call = scoreSummary(summarize([trip({ events: [{ type: "phone_call", at: "2026-10-01T15:05:00.000Z", durationS: 1200 }] })]));
    expect(call).toEqual({ score: 100, parts: { hardEvents: 0, overLimit: 0, phoneUnlocks: 0 } });
  });

  it("caps each part and never goes below zero", () => {
    const awful = scoreSummary(summarize([trip({
      speedBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1800],
      events: [
        ...Array.from({ length: 30 }, () => ({ type: "hard_brake", at: "x" })),
        ...Array.from({ length: 10 }, (_, i) => ({ type: "phone_unlocked", at: `2026-10-01T15:${10 + i}:00.000Z`, durationS: 10 })),
      ],
    })], 100));
    expect(awful).toEqual({ score: 0, parts: { hardEvents: 40, overLimit: 30, phoneUnlocks: 30 } });
  });

  it("is not moved by a dismissed trip", () => {
    const clean = trip({ speedBands: [0, 0, 0, 1800] });
    const bad = trip({ id: "bus", status: "passenger", events: Array.from({ length: 9 }, () => ({ type: "hard_brake", at: "x" })) });
    expect(scoreSummary(summarize([clean, bad], 100)).score).toBe(100);
  });
});

describe("groupByDay", () => {
  it("lists days newest first, and the newest trip first within a day", () => {
    const dayOf = (t) => t.startedAt.slice(0, 10);
    const groups = groupByDay([
      trip({ id: "a", startedAt: "2026-10-01T08:00:00.000Z" }),
      trip({ id: "b", startedAt: "2026-10-02T08:00:00.000Z" }),
      trip({ id: "c", startedAt: "2026-10-01T17:00:00.000Z" }),
    ], dayOf);
    expect(groups.map((g) => [g.day, g.trips.map((t) => t.id)])).toEqual([
      ["2026-10-02", ["b"]], ["2026-10-01", ["c", "a"]],
    ]);
  });
});

describe("who is shown, and who may do what", () => {
  it("names only the drivers whose trips arrived, the viewer first", () => {
    const trips = [trip({ memberId: "teen" }), trip({ memberId: "mom" }), trip({ memberId: "gone" })];
    expect(driversFrom(trips, MEMBERS, "mom")).toEqual([
      { id: "mom", name: "You" }, { id: "gone", name: "Member" }, { id: "teen", name: "Sam" },
    ]);
    // A member with no trips is not listed, whoever they are.
    expect(driversFrom([], MEMBERS, "mom")).toEqual([]);
    // …unless the viewer holds a limit for them: it must stay reachable in a
    // month they did not drive. A limit left behind by a removed member is not.
    expect(driversFrom([], MEMBERS, "mom", ["teen", "gone"])).toEqual([{ id: "teen", name: "Sam" }]);
    expect(driversFrom(trips, MEMBERS, "mom", ["teen"])).toHaveLength(3);
  });

  it("lets a member mark their own trip and an adult a non-adult's — and nobody an adult's private one", () => {
    // Marking follows reading on the hub, so a trip that arrived is markable —
    // including for the account holder, who has no member row at all.
    expect(canMark(trip())).toBe(true);
    expect(canMark(trip({ memberId: "mom", selfOnly: true }))).toBe(true);
    expect(canMark(null)).toBe(false);
  });

  it("puts a monitored driver in the picker before their first drive", () => {
    expect(driversFrom([], MEMBERS, "mom", [], ["teen", "gone"])).toEqual([{ id: "teen", name: "Sam" }]);
  });
});

describe("recordingNotice", () => {
  const NOW = Date.parse("2026-10-20T12:00:00.000Z");
  const status = (over = {}) => ({ memberId: "teen", recording: true, phoneSeenAt: "2026-10-20T11:00:00.000Z", ...over });
  const recent = [trip({ endedAt: "2026-10-18T15:30:00.000Z" })];

  it("says nothing for a driver who is not monitored, or one whose drives are arriving", () => {
    expect(recordingNotice(undefined, recent, NOW)).toBeNull();
    expect(recordingNotice(status(), recent, NOW)).toBeNull();
    // A hub with no tracker registry sends no check-in time: the drives speak.
    expect(recordingNotice(status({ phoneSeenAt: null }), recent, NOW)).toBeNull();
  });

  it("says the driver's own choice has stopped recording, before anything else", () => {
    expect(recordingNotice(status({ recording: false, phoneSeenAt: null }), [], NOW)).toEqual({ reason: "not_recording" });
  });

  it("names a phone that has gone quiet for days, even with recent drives", () => {
    expect(recordingNotice(status({ phoneSeenAt: "2026-10-16T11:00:00.000Z" }), recent, NOW))
      .toEqual({ reason: "phone_quiet", since: "2026-10-16T11:00:00.000Z" });
    // Parked for a weekend is not quiet.
    expect(recordingNotice(status({ phoneSeenAt: "2026-10-18T11:00:00.000Z" }), recent, NOW)).toBeNull();
  });

  it("mentions a fortnight with no drives — the driver's own trips only", () => {
    expect(recordingNotice(status(), [], NOW)).toEqual({ reason: "no_drives", days: NO_DRIVES_DAYS });
    expect(recordingNotice(status(), [trip({ endedAt: "2026-10-01T15:30:00.000Z" })], NOW))
      .toEqual({ reason: "no_drives", days: NO_DRIVES_DAYS });
    expect(recordingNotice(status(), [trip({ memberId: "kid", endedAt: "2026-10-19T15:30:00.000Z" })], NOW))
      .toEqual({ reason: "no_drives", days: NO_DRIVES_DAYS });
  });
});

describe("limits", () => {

  it("lets an adult set a limit for a non-adult driver only", () => {
    const mom = MEMBERS[0], teen = MEMBERS[2];
    expect(canSetLimit("teen", mom, MEMBERS)).toBe(true);
    expect(canSetLimit("teen", teen, MEMBERS)).toBe(false);
    // An adult's drives are private; a limit row would tell the other adults.
    expect(canSetLimit("dad", mom, MEMBERS)).toBe(false);
    expect(canSetLimit("mom", mom, MEMBERS)).toBe(false);
    expect(canSetLimit("gone", mom, MEMBERS)).toBe(false);
  });
});

describe("formatting", () => {
  it("shows distance and speed in either unit", () => {
    expect(formatDistance(25_000)).toBe("25 km");
    expect(formatDistance(25_000, "mi")).toBe("15.5 mi");
    expect(formatDistance(402_336, "mi")).toBe("250 mi");
    expect(formatSpeed(104.6, "mi")).toBe("65 mph");
    expect(formatSpeed(96.4)).toBe("96 km/h");
  });

  it("shows a length of time at the size it is", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(150)).toBe("3 min");
    expect(formatDuration(3900)).toBe("1 h 5 min");
    expect(formatDuration(-5)).toBe("0 s");
  });

  it("stores a typed limit as km/h and shows it back in the unit it was typed in", () => {
    expect(limitToKph("65", "mi")).toBe(105);
    expect(limitFromKph(105, "mi")).toBe(65);
    expect(limitToKph("100")).toBe(100);
    for (const bad of ["", "abc", "0", "-5", "5", "900"]) expect(limitToKph(bad)).toBeNull();
  });

  it("describes where a trip went with the place names it has", () => {
    expect(tripRoute(trip({ start: { label: "Home" }, end: { label: "School" } }))).toBe("Home → School");
    expect(tripRoute(trip({ start: {}, end: { label: "School" } }))).toBe("To School");
    expect(tripRoute(trip({ start: { label: "Home" }, end: {} }))).toBe("From Home");
    expect(tripRoute(trip())).toBe("Drive");
  });
});

describe("speedProfile", () => {
  it("is one bar per band with time in it, with its share and whether it is over the limit", () => {
    const bars = speedProfile(trip().speedBands, 100);
    expect(bars.map((bar) => [bar.label, bar.seconds, bar.over])).toEqual([
      ["30–40", 300, false], ["90–100", 1200, false], ["110–120", 300, true],
    ]);
    expect(bars.reduce((sum, bar) => sum + bar.share, 0)).toBeCloseTo(1);
  });

  it("labels the bands in miles per hour when asked", () => {
    expect(speedProfile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60], null, "mi")[0].label).toBe("68–75");
  });

  it("is empty for a missing or empty profile", () => {
    expect(speedProfile(undefined, 100)).toEqual([]);
    expect(speedProfile([0, 0], 100)).toEqual([]);
  });
});

describe("demo data", () => {
  it("is a few trips in the hub's shape, so the app renders with no hub", () => {
    const trips = demoTrips(Date.parse("2026-10-01T18:00:00.000Z"));
    expect(trips.length).toBeGreaterThan(2);
    for (const t of trips) {
      expect(typeof t.id).toBe("string");
      expect(Array.isArray(t.speedBands)).toBe(true);
      expect(["unconfirmed", "driver", "passenger", "ignored"]).toContain(t.status);
      expect(Date.parse(t.endedAt)).toBeGreaterThan(Date.parse(t.startedAt));
    }
  });
});
