export async function forEachConcurrent<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  let index = 0;
  const next = async (): Promise<void> => {
    while (index < values.length) await worker(values[index++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, next));
}
