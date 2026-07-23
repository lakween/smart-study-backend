const INTERVAL_LADDER = [1, 3, 7, 14, 30];
const PASS_THRESHOLD = 60;

export function computeNextRevision(previousIntervalDays: number | null, scorePercent: number) {
  let intervalDays: number;

  if (scorePercent < PASS_THRESHOLD) {
    intervalDays = INTERVAL_LADDER[0];
  } else if (previousIntervalDays == null) {
    intervalDays = INTERVAL_LADDER[0];
  } else {
    const currentIndex = INTERVAL_LADDER.indexOf(previousIntervalDays);
    const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, INTERVAL_LADDER.length - 1);
    intervalDays = INTERVAL_LADDER[nextIndex];
  }

  const nextRevisionDate = new Date();
  nextRevisionDate.setDate(nextRevisionDate.getDate() + intervalDays);

  return { intervalDays, nextRevisionDate };
}
