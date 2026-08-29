export function retry<T>(operation: () => T, attempts: number): T { return operation(); }
