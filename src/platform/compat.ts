/** Add the missing method without replacing Hermes/RN's instrumented Promise. */
export function installPromiseWithResolvers(
  constructor: PromiseConstructor = Promise,
) {
  if (typeof constructor.withResolvers === "function") return;
  Object.defineProperty(constructor, "withResolvers", {
    configurable: true,
    writable: true,
    value: function <T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new this<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    },
  });
}
