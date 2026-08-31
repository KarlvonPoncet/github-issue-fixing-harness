export function windowAverage(values: number[], window: number): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
