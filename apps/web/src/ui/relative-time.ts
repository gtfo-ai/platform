/**
 * "5 m ago" — how long ago something happened, in the units a list row has room for (GitHub's
 * "updated 5 minutes ago", abbreviated). `now` is a parameter: a component must not read a clock
 * (`useServices().now`, so a test holds the time still).
 *
 * A time in the future (a clock skew between the server and this machine) reads "just now" rather
 * than a negative age, and an unreadable one reads as nothing at all — `null`, for the caller to
 * leave the fact out.
 */
export const formatAgo = (iso: string, nowMs: number): string | null => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
};
