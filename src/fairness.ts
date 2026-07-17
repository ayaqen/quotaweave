export function jainFairnessIndex(values: readonly number[]): number {
  const active = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (active.length === 0) return 1;

  const sum = active.reduce((total, value) => total + value, 0);
  if (sum === 0) return 1;
  const squaredSum = active.reduce((total, value) => total + value * value, 0);
  return (sum * sum) / (active.length * squaredSum);
}
