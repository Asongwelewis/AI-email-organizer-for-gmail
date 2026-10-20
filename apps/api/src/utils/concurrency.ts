/**
 * Runs `work` over `items` with at most `limit` in flight, and resolves when all have settled.
 *
 * Each item's failure is its own: a rejection is returned in its slot rather than abandoning the
 * rest, because every caller here is a loop over accounts or messages where one bad entry must
 * not stop the others.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        await work(items[index]!, index);
        results[index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}
