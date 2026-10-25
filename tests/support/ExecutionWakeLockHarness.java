package dev.verysmallwoods.background;

import java.util.ArrayList;
import java.util.List;

/** Android boundary doubles; the lifecycle under test is production Java. */
public final class ExecutionWakeLockHarness {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static final class Clock implements ExecutionWakeLock.Scheduler {
    record Event(Runnable callback, long at) {}
    final List<Event> events = new ArrayList<>();
    long now;
    public void postDelayed(Runnable callback, long delay) {
      events.add(new Event(callback, now + delay));
    }
    public void removeCallbacks(Runnable callback) {
      events.removeIf(event -> event.callback() == callback);
    }
    void advance(long until) {
      while (true) {
        Event next = events.stream().filter(event -> event.at() <= until)
          .min(java.util.Comparator.comparingLong(Event::at)).orElse(null);
        if (next == null) break;
        events.remove(next);
        now = next.at();
        next.callback().run();
      }
      now = until;
    }
  }

  private static final class Lock implements ExecutionWakeLock.Lock {
    final Clock clock;
    int acquisitions;
    int releases;
    long expires;
    boolean fail;
    Lock(Clock clock) { this.clock = clock; }
    public void acquire(long timeout) {
      if (fail) throw new IllegalStateException("acquire failed");
      check(timeout > 0 && timeout < 7_200_000, "every acquisition must expire before the long task ends");
      if (acquisitions > 0) check(clock.now < expires, "lock expired before renewal");
      acquisitions++;
      expires = clock.now + timeout;
    }
    public void release() { releases++; }
  }

  public static void main(String[] args) {
    Clock clock = new Clock();
    Lock lock = new Lock(clock);
    int[] failures = {0};
    ExecutionWakeLock lease = new ExecutionWakeLock(clock, lock, () -> failures[0]++);
    if (args[0].equals("startup-failure")) {
      lock.fail = true;
      try {
        lease.start();
        throw new AssertionError("startup must fail");
      } catch (IllegalStateException expected) {
        check(clock.events.isEmpty(), "failed startup left renewal queued");
      }
    } else {
      lease.start();
      lease.start();
      check(lock.acquisitions == 1, "duplicate start acquired twice");
      Runnable late = clock.events.get(0).callback();
      switch (args[0]) {
        case "long-run" -> {
          clock.advance(7_200_000);
          check(failures[0] == 0 && lock.releases == 0, "long task was stopped");
          check(lock.acquisitions > 1 && lock.expires > clock.now, "long task lost lock");
          check(clock.events.size() == 1, "renewal leaked timers");
          lease.stop();
        }
        case "stop", "late-callback" -> {
          clock.advance(30_000);
          lease.stop();
          lease.stop();
          if (args[0].equals("late-callback")) late.run();
          clock.advance(7_200_000);
          check(lock.acquisitions == 1, "stopped lease reacquired lock");
          check(lock.releases == 1 && clock.events.isEmpty(), "stop leaked resources");
        }
        case "restart" -> {
          lease.stop();
          lease.start();
          late.run();
          check(lock.acquisitions == 2 && clock.events.size() == 1, "old callback affected new lease");
          lease.stop();
        }
        case "renewal-failure" -> {
          lock.fail = true;
          clock.advance(600_000);
          check(failures[0] == 1 && lock.releases == 1, "failure did not stop lease");
          check(clock.events.isEmpty(), "failed renewal kept retrying");
          lease.stop();
          check(lock.releases == 1, "failure released twice");
        }
        default -> throw new AssertionError("unknown scenario");
      }
    }
    System.out.println("PASS");
  }
}
