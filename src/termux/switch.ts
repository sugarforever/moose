/** Replace a closed SQLite/runtime owner; never open two owners at once. */
export async function replaceRuntime<T>(options: {
  current: T;
  assertIdle(): Promise<void>;
  select(): Promise<void>;
  close(current: T): Promise<void>;
  open(): Promise<T>;
  restore(): Promise<void>;
  reopen(): Promise<T>;
}): Promise<{ runtime: T; error?: unknown }> {
  await options.assertIdle();
  await options.select();
  let closed = false;
  try {
    await options.assertIdle();
    closed = true;
    await options.close(options.current);
    return { runtime: await options.open() };
  } catch (error) {
    await options.restore();
    return {
      runtime: closed ? await options.reopen() : options.current,
      error,
    };
  }
}
