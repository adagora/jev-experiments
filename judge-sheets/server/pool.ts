/** Run async jobs with a concurrency limit, delivering results as they finish. */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult: (result: R, index: number) => void,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const r = await worker(items[i], i);
      onResult(r, i);
    }
  });
  await Promise.all(lanes);
}
