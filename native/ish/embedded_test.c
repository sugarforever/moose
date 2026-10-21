/* Real pinned iSH integration harness. No host shell executes guest commands.
 */
#include "embedded.h"
#include "embedded_guest_bytes.h"
#include <assert.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static moose_ish_result execute(const char *root, const char *script,
                                unsigned timeout, char *out) {
  char name[] = "/tmp/moose-ish-output-XXXXXX";
  int fd = mkstemp(name);
  unlink(name);
  int input = open("/dev/null", O_RDONLY);
  const char *argv[] = {"/bin/sh", "-c", script};
  const char *env[] = {"PATH=/bin:/usr/bin", "TEST_VALUE=literal value"};
  moose_ish_options options = {root, "/workspace", 3,  argv, 2,
                               env,  input,        fd, fd,   timeout};
  moose_ish_command *command = moose_ish_command_create(&options);
  assert(command);
  moose_ish_result result = {0};
  assert(moose_ish_command_run(command, &result) == 0);
  moose_ish_command_destroy(command);
  lseek(fd, 0, SEEK_SET);
  ssize_t n = read(fd, out, 4095);
  assert(n >= 0);
  out[n] = 0;
  close(fd);
  close(input);
  return result;
}
struct pending {
  moose_ish_command *command;
  moose_ish_result result;
};
static void *run_pending(void *value) {
  struct pending *p = value;
  assert(moose_ish_command_run(p->command, &p->result) == 0);
  return NULL;
}
static void cancel_descendants(const char *root) {
  int fd = open("/dev/null", O_RDWR);
  const char *args[] = {
      "/bin/sh", "-c",
      "setsid sh -c 'sleep 1; echo unsafe > cancelled-child' & sleep 30"};
  moose_ish_options o = {root, "/workspace", 3, args, 0, NULL, fd, fd, fd, 0};
  struct pending p = {moose_ish_command_create(&o), {0}};
  assert(p.command);
  pthread_t thread;
  assert(!pthread_create(&thread, NULL, run_pending, &p));
  usleep(100000);
  moose_ish_command_cancel(p.command);
  pthread_join(thread, NULL);
  assert(p.result.cancelled && !p.result.timed_out &&
         p.result.exit_code == 137);
  moose_ish_command_destroy(p.command);
  close(fd);
  sleep(2);
  char out[4096];
  moose_ish_result r =
      execute(root, "test ! -e cancelled-child && echo alive", 2000, out);
  assert(r.exit_code == 0 && !strcmp(out, "alive\n"));
}
static void streams_argv(const char *root) {
  char n1[] = "/tmp/moose-stream-out-XXXXXX",
       n2[] = "/tmp/moose-stream-err-XXXXXX";
  int out = mkstemp(n1), err = mkstemp(n2);
  unlink(n1);
  unlink(n2);
  int pipes[2];
  assert(!pipe(pipes));
  assert(write(pipes[1], "input", 5) == 5);
  close(pipes[1]);
  const char *args[] = {"/bin/sh", "-c",
                        "cat; printf '%s' \"$1\"; echo error >&2", "test",
                        "literal; $(false)"};
  moose_ish_options o = {root, "/workspace", 5,   args, 0,
                         NULL, pipes[0],     out, err,  2000};
  moose_ish_command *c = moose_ish_command_create(&o);
  assert(c);
  moose_ish_result r;
  assert(!moose_ish_command_run(c, &r));
  assert(!r.error && !r.exit_code);
  moose_ish_command_destroy(c);
  char buffer[100] = {0};
  lseek(out, 0, SEEK_SET);
  read(out, buffer, 99);
  assert(!strcmp(buffer, "inputliteral; $(false)"));
  memset(buffer, 0, 100);
  lseek(err, 0, SEEK_SET);
  read(err, buffer, 99);
  assert(!strcmp(buffer, "error\n"));
  close(out);
  close(err);
  close(pipes[0]);
}
static void initialization_race(const char *first, const char *second) {
  int fd = open("/dev/null", O_RDWR);
  const char *args[] = {"/bin/true"};
  moose_ish_options a = {first, "/workspace", 1,  args, 0,
                         NULL,  fd,           fd, fd,   2000};
  moose_ish_options b = a;
  b.root = second;
  struct pending p = {moose_ish_command_create(&a), {0}},
                 q = {moose_ish_command_create(&b), {0}};
  assert(p.command && q.command);
  pthread_t t1, t2;
  assert(!pthread_create(&t1, NULL, run_pending, &p));
  assert(!pthread_create(&t2, NULL, run_pending, &q));
  pthread_join(t1, NULL);
  pthread_join(t2, NULL);
  assert(!p.result.error && !p.result.exit_code && !q.result.error &&
         !q.result.exit_code);
  moose_ish_command_destroy(p.command);
  moose_ish_command_destroy(q.command);
  close(fd);
}
static void cancel_queued(const char *root) {
  int output[2];
  assert(!pipe(output));
  int fd = open("/dev/null", O_RDWR);
  const char *long_args[] = {"/bin/sh", "-c", "echo ready; sleep 2"};
  const char *short_args[] = {"/bin/true"};
  moose_ish_options a = {root, "/workspace", 3,         long_args, 0,
                         NULL, fd,           output[1], fd,        0};
  moose_ish_options b = {root, "/workspace", 1,  short_args, 0,
                         NULL, fd,           fd, fd,         0};
  struct pending p = {moose_ish_command_create(&a), {0}},
                 q = {moose_ish_command_create(&b), {0}};
  assert(p.command && q.command);
  pthread_t t1, t2;
  assert(!pthread_create(&t1, NULL, run_pending, &p));
  char ready[6];
  assert(read(output[0], ready, 6) > 0);
  assert(!pthread_create(&t2, NULL, run_pending, &q));
  usleep(30000);
  struct timespec begin, end;
  clock_gettime(CLOCK_MONOTONIC, &begin);
  moose_ish_command_cancel(q.command);
  pthread_join(t2, NULL);
  clock_gettime(CLOCK_MONOTONIC, &end);
  assert((end.tv_sec - begin.tv_sec) * 1000 +
             (end.tv_nsec - begin.tv_nsec) / 1000000 <
         500);
  assert(q.result.cancelled);
  const char *queued_args[] = {"/bin/sh", "-c", "echo unsafe > queued-started"};
  moose_ish_options queued = {root, "/workspace", 3,  queued_args, 0,
                              NULL, fd,           fd, fd,          30};
  moose_ish_command *expired = moose_ish_command_create(&queued);
  assert(expired);
  moose_ish_result timeout_result;
  assert(!moose_ish_command_run(expired, &timeout_result));
  assert(timeout_result.timed_out && timeout_result.exit_code == 137);
  moose_ish_command_destroy(expired);
  moose_ish_command_cancel(p.command);
  pthread_join(t1, NULL);
  moose_ish_command_destroy(p.command);
  moose_ish_command_destroy(q.command);
  close(fd);
  close(output[0]);
  close(output[1]);
  char out[4096];
  moose_ish_result check =
      execute(root, "test ! -e queued-started && echo queue-safe", 1000, out);
  assert(!check.error && !check.exit_code && strstr(out, "queue-safe"));
}
static void direct_sleep_timeout(const char *root) {
  int fd = open("/dev/null", O_RDWR);
  const char *args[] = {"/bin/sleep", "2"};
  moose_ish_options options = {root, "/workspace", 2,  args, 0,
                               NULL, fd,           fd, fd,   20};
  for (int i = 0; i < 5; i++) {
    moose_ish_command *command = moose_ish_command_create(&options);
    assert(command);
    struct timespec begin, end;
    clock_gettime(CLOCK_MONOTONIC, &begin);
    moose_ish_result result;
    assert(!moose_ish_command_run(command, &result));
    clock_gettime(CLOCK_MONOTONIC, &end);
    assert(result.timed_out && result.exit_code == 137);
    assert((end.tv_sec - begin.tv_sec) * 1000 +
               (end.tv_nsec - begin.tv_nsec) / 1000000 <
           500);
    moose_ish_command_destroy(command);
  }
  close(fd);
}
static void guest_resource_syscalls(const char *root) {
  char name[] = "/tmp/moose-fixture-input-XXXXXX";
  int input = mkstemp(name);
  unlink(name);
  assert(input >= 0);
  assert(write(input, guest_resource_test, sizeof(guest_resource_test)) ==
         sizeof(guest_resource_test));
  lseek(input, 0, SEEK_SET);
  int fd = open("/dev/null", O_RDWR);
  const char *args[] = {"/bin/sh", "-c",
                        "cat > native-resource-test; chmod 700 "
                        "native-resource-test; exec ./native-resource-test"};
  moose_ish_options options = {root, "/workspace", 3,  args, 0,
                               NULL, input,        fd, fd,   3000};
  moose_ish_command *command = moose_ish_command_create(&options);
  assert(command);
  moose_ish_result result;
  assert(!moose_ish_command_run(command, &result));
  if (result.error || result.exit_code)
    fprintf(stderr, "resource fixture error=%d status=%d timeout=%d\n",
            result.error, result.exit_code, result.timed_out);
  assert(!result.error && !result.exit_code && !result.timed_out);
  moose_ish_command_destroy(command);
  close(fd);
  close(input);
}
static int count_host_fds(void) {
  int count = 0;
  for (int fd = 0; fd < 1024; fd++)
    if (fcntl(fd, F_GETFD) >= 0)
      count++;
  return count;
}
static void steady_descriptors(const char *root) {
  int before = count_host_fds();
  char out[4096];
  for (int i = 0; i < 12; i++) {
    moose_ish_result r = execute(root, "true", 1000, out);
    assert(!r.error && !r.exit_code);
  }
  assert(count_host_fds() <= before);
}
int main(int argc, char **argv) {
  assert(argc == 3);
  char out[4096];
  initialization_race(argv[1], argv[2]);
  moose_ish_result r = execute(
      argv[1], "test -c /dev/null && test -c /dev/zero && "
               "test -c /dev/urandom && printf ok > /dev/null && echo devices-ready",
      2000, out);
  assert(!r.error && !r.exit_code && !strcmp(out, "devices-ready\n"));
  r =
      execute(argv[1], "printf '%s' \"$TEST_VALUE\"; exit 7", 2000, out);
  assert(r.error == 0 && r.exit_code == 7 && !strcmp(out, "literal value"));
  r = execute(argv[1], "echo first > state; cat state | tr a-z A-Z", 2000, out);
  assert(r.exit_code == 0 && !strcmp(out, "FIRST\n"));
  r = execute(argv[2], "test ! -e state; echo second > state; cat state", 2000,
              out);
  assert(r.exit_code == 0 && !strcmp(out, "second\n"));
  r = execute(argv[1], "cat state; kill -9 1; echo survived", 2000, out);
  assert(r.exit_code == 0 && strstr(out, "first\n") && strstr(out, "survived"));
  r = execute(argv[1],
              "setsid sh -c 'sleep 1; echo escaped > escaped' & sleep 30", 80,
              out);
  assert(r.timed_out && r.exit_code == 137);
  sleep(2);
  r = execute(argv[1], "test ! -e escaped && echo alive", 2000, out);
  assert(r.exit_code == 0 && !strcmp(out, "alive\n"));
  r = execute(argv[1],
              "mkdir -p /workspace/mnt; if mount -t real /tmp /workspace/mnt; "
              "then echo UNSAFE; exit 1; fi; echo denied",
              2000, out);
  assert(r.exit_code == 0 && strstr(out, "denied") && !strstr(out, "UNSAFE"));
  r = execute(argv[1], "kill -9 32769; kill -9 -- -32769; echo survived", 2000,
              out);
  assert(r.exit_code == 0 && strstr(out, "survived"));
  r = execute(argv[1],
              "i=0; while test $i -lt 40; do sleep 30 & i=$((i+1)); done; wait",
              3000, out);
  assert(!r.timed_out && r.exit_code != 0 &&
         strstr(out, "Resource temporarily unavailable"));
  r = execute(argv[1],
              "dd if=/dev/zero of=resource-file bs=1048576 count=17; code=$?; "
              "test $code -ne 0 && test $(stat -c %s resource-file) -eq "
              "16777216 && echo file-bounded",
              3000, out);
  assert(r.exit_code == 0 && strstr(out, "file-bounded"));
  r = execute(argv[1],
              "truncate -s 16777217 truncate-file; test $? -ne 0 && echo "
              "truncate-bounded",
              2000, out);
  assert(r.exit_code == 0 && strstr(out, "truncate-bounded"));
  r = execute(argv[1],
              "dd if=/dev/zero of=/dev/null bs=300M count=0; test $? -ne 0 && "
              "echo memory-bounded",
              2000, out);
  assert(r.exit_code == 0 && strstr(out, "memory-bounded"));
  guest_resource_syscalls(argv[1]);
  direct_sleep_timeout(argv[1]);
  cancel_queued(argv[1]);
  cancel_descendants(argv[1]);
  streams_argv(argv[1]);
  r = execute(
      argv[1],
      "ln -sf /tmp/moose-core-b/data/workspace/state leak; test ! -r leak && "
      "test ! -r /proc/1/root && test $(id -u) = 501 && echo isolated",
      2000, out);
  assert(r.exit_code == 0 && !strcmp(out, "isolated\n"));
  r = execute(argv[1],
              "if nc -w 1 127.0.0.1 9; then exit 1; fi; echo network-denied",
              2000, out);
  assert(r.exit_code == 0 && strstr(out, "network-denied") &&
         strstr(out, "Operation not permitted"));
  steady_descriptors(argv[1]);
  puts("PASS embedded real core: repeat, streams/status/env, pipeline, roots, "
       "PID1, descendants, timeout");
  return 0;
}
