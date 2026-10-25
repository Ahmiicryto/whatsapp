/** Wall clock parts of `date` in an IANA timezone. */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday, // Mon, Tue...
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Offset (ms) of a timezone at a given instant. */
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, date.getUTCSeconds());
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight for dateKey (YYYY-MM-DD) in timeZone. */
export function startOfLocalDay(dateKey, timeZone) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const offset = tzOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** If now is inside quiet hours, returns the Date when quiet hours end, otherwise null. */
export function quietHoursEnd(now, timeZone, quiet) {
  if (!quiet?.enabled) return null;
  const p = zonedParts(now, timeZone);
  const cur = p.hour * 60 + p.minute;
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!inside) return null;
  let wait = end - cur;
  if (wait <= 0) wait += 1440;
  return new Date(now.getTime() + wait * 60000);
}

export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
