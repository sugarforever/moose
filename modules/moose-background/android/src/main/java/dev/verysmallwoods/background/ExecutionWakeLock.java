package dev.verysmallwoods.background;

/** Execution lock lifecycle, with Android operations supplied by the service. */
final class ExecutionWakeLock {
  private static final long LOCK_TIMEOUT_MS = 10L * 60 * 1000;
  private static final long RENEW_AFTER_MS = 5L * 60 * 1000;
  interface Scheduler {
    void postDelayed(Runnable callback, long delay);
    void removeCallbacks(Runnable callback);
  }
  interface Lock {
    void acquire(long timeout);
    void release();
  }
  private final Scheduler scheduler;
  private final Lock lock;
  private final Runnable onFailure;
  private boolean active;
  private long generation;
  private Runnable renewal;

  ExecutionWakeLock(Scheduler scheduler, Lock lock, Runnable onFailure) {
    this.scheduler = scheduler;
    this.lock = lock;
    this.onFailure = onFailure;
  }
  void start() {
    if (active) return;
    active = true;
    long current = ++generation;
    renewal = () -> {
      if (!active || generation != current) return;
      try {
        lock.acquire(LOCK_TIMEOUT_MS);
        scheduler.postDelayed(renewal, RENEW_AFTER_MS);
      } catch (RuntimeException error) {
        stop();
        onFailure.run();
      }
    };
    try {
      lock.acquire(LOCK_TIMEOUT_MS);
      scheduler.postDelayed(renewal, RENEW_AFTER_MS);
    } catch (RuntimeException error) {
      stop();
      throw error;
    }
  }
  void stop() {
    if (!active) return;
    active = false;
    scheduler.removeCallbacks(renewal);
    lock.release();
  }
}
