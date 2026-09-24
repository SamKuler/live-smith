export function providerRetryAfterMs(
  headers: Headers,
): number | undefined {
  const milliseconds = parseDelay(headers.get("retry-after-ms"), 1);
  if (milliseconds !== undefined) return milliseconds;
  const retryAfter = headers.get("retry-after");
  return parseDelay(retryAfter, 1_000) ?? parseHttpDateDelay(retryAfter);
}

function parseDelay(value: string | null, multiplier: number): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return undefined;
  }
  const milliseconds = Math.ceil(Number(value) * multiplier);
  if (!Number.isFinite(milliseconds)) return undefined;
  return milliseconds;
}

function parseHttpDateDelay(value: string | null): number | undefined {
  if (value === null) return undefined;
  let date = value;
  const obsoleteRfc850 = /^([A-Za-z]{6,9}), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/u.exec(value);
  const obsoleteAsctime = /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/u.exec(value);
  if (obsoleteRfc850) {
    const currentYear = new Date(Date.now()).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(obsoleteRfc850[4]);
    if (year - currentYear > 50) year -= 100;
    date = `${obsoleteRfc850[1]!.slice(0, 3)}, ${obsoleteRfc850[2]} ${obsoleteRfc850[3]} ${year} ${obsoleteRfc850[5]} GMT`;
  } else if (obsoleteAsctime) {
    date = `${obsoleteAsctime[1]}, ${obsoleteAsctime[3]!.trim().padStart(2, "0")} ${obsoleteAsctime[2]} ${obsoleteAsctime[5]} ${obsoleteAsctime[4]} GMT`;
  } else if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== date) return undefined;
  return Math.max(0, timestamp - Date.now());
}
