const DAY = 86_400_000;
export const NOTICE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const NOTICE_STATES = ['scheduled', 'rescheduled', 'postponed', 'cancelled'];

export function localTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value)) return NaN;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return NaN;
  return Date.parse(`${value.length === 10 ? `${value}T00:00` : value}:00+08:00`);
}

export function sessionEnd({ start, end }) {
  // A date-only end includes that entire day. An unspecified end uses the end of the start day.
  const value = end || start.slice(0, 10);
  return localTime(value) + (value.length === 10 ? DAY : 0);
}

export function noticeWindow(notice) {
  const end = sessionEnd(notice.sessions.at(-1));
  return {
    start: localTime(notice.sessions[0].start),
    until: notice.visible_through ? Math.max(end, sessionEnd({ start: notice.visible_through })) : end,
  };
}
