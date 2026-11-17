// The light outside, from the sun's real height at a place (no network needed).
// sunElevation(date, lat, lon) → degrees above the horizon (NOAA-style approximation, good to well under a degree).
// lightPhrase(date, lat, lon, tz) → a short phrase such as "golden hour, the sun going down".
const rad = Math.PI / 180;

function sunElevation(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(lha)) / rad;
}

function localHour(date, tz, lon) {
  if (!tz) return Math.floor((((date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15) % 24) + 24) % 24); // sun time
  try {
    return Number(new Intl.DateTimeFormat("en-CA", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(date));
  } catch {
    return date.getUTCHours();
  }
}

function lightPhrase(date, lat, lon, tz) {
  const now = sunElevation(date, lat, lon);
  const rising = sunElevation(new Date(date.getTime() + 10 * 60000), lat, lon) > now;
  if (now < -6) {
    const h = localHour(date, tz, lon);
    return h >= 0 && h < 4 ? "the dead of night" : h < 12 ? "night, before dawn" : "night";
  }
  if (now < 0) return rising ? "dawn, the sky just paling" : "dusk, the last light fading";
  if (now < 6) return rising ? "early morning, low sun" : "golden hour, the sun going down";
  const h = localHour(date, tz, lon);
  return h < 12 ? "morning daylight" : h < 17 ? "afternoon daylight" : "evening daylight";
}

module.exports = { sunElevation, lightPhrase };
