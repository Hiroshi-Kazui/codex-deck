export function clamp(value, min, max) {
  if (![value, min, max].every(Number.isFinite)) {
    throw new TypeError('value, min, and max must be finite numbers');
  }
  if (min > max) {
    throw new RangeError('min must not exceed max');
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
