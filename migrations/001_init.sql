-- One row per driver: the speed an adult has set as that driver's limit.
--
-- The hub keeps no speed limit. A trip arrives with the seconds spent in each
-- 10 km/h band, and this app applies the limit when it READS the trip — so a
-- limit changed today applies to last week's drives too, and a driver with no
-- row here simply has no "over the limit" figure.
--
-- Adults write; a driver reads their own row and nobody else's (the
-- `driver_limits` row policy in manifest.json).
--
-- No "set by" or "set at" column: both would be whatever the browser sent, and
-- nothing reads them.
CREATE TABLE IF NOT EXISTS app_safe_driving__driver_limits (
  id         TEXT PRIMARY KEY,       -- the driver's member id again: one row per driver
  member_id  TEXT NOT NULL UNIQUE,   -- the driver (plaintext: ends in _id)
  -- Always km/h, whatever unit the screen shows. A number, so never encrypted,
  -- which is what lets the range be checked here rather than only in the app.
  limit_kph  INTEGER NOT NULL CHECK (limit_kph BETWEEN 20 AND 250)
);
