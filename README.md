# Safe Driving

A [Chickadee Bandit](https://chickadeebandit.com/app-library/safe-driving) app.

Drive reports for new drivers. The **Chickadee Locate** companion app on the
driver's phone records each drive; the hub stores it; this app shows it.

- **Drives are the hub's, not this app's.** They arrive through the
  `family.drives` context key: timings, distance, average and top speed, the
  seconds spent in each 10 km/h band, and events (hard braking, hard
  acceleration, phone on a call, phone unlocked). The hub decides who may read
  whose: a driver their own, a supervising adult a non-adult's, and an adult's
  own drives nobody's but theirs. This app shows what it is handed.
- **Nothing is recorded until an adult turns drive monitoring on** for a
  driver, on the hub's Location page, and the driver's phone has shown what it
  records.
- **The week.** Drives, distance, time, night minutes, events and a score out
  of 100. A drive nobody has marked COUNTS; only "passenger" and "not a drive"
  are left out. The score is made of rates (hard events per distance, share of
  the time over the limit, times the phone was unlocked while driving per
  hour), so a long week is not punished for being long. A phone unlocked for
  the whole drive costs nothing — that is a phone giving directions — and
  neither does how long it stayed unlocked; unlocking it mid-drive does. Calls
  are shown and not scored: the phone cannot tell a hands-free call from one
  held to the ear.
- **Marking a trip.** A driver marks their own trips; a supervising adult marks
  or overrides a non-adult's. It is a label: the route and everything recorded
  stay, the history of labels is kept on the hub, and a dismissed trip is still
  shown, under "Not driving". Written through
  `/run/safe-driving/api/drives/trip-status`, which the hub serves because the
  manifest declares `family.drives` in `data_access.writes`.
- **Speed limit.** The hub holds no limit. An adult sets one per non-adult
  driver here (`driver_limits`, this app's only table), and it is applied when
  a drive is read — so a changed limit applies to past drives too. Only time in
  bands wholly at or over the limit is counted.
- **"Phone unlocked" means unlocked**, not used. An unlocked stretch that
  starts with the trip was already under way (a mount, directions) and is
  shown as "unlocked from the start"; one that starts later is someone
  unlocking the phone while driving.
- **The route** is fetched per trip (`family.drives.trip:{id}`) and is gone
  after the hub's 30-day route retention; the summary stays.
- **No alerts yet.** Nothing here sends a push.

Dev: `make install && make build && make test`. `make dev` serves the app with
demo data.
