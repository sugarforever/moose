/* iSH embedding owner. Upstream iSH license applies to linked kernel; see
 * NOTICE.md. */
// Preserve upstream header prerequisites (fs/path.h is not standalone).
// clang-format off
#include "embedded.h"
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include "fs/real.h"
#include "fs/path.h"
#include "fs/devices.h"
// clang-format on

extern int become_new_init_child_domain(unsigned domain);
struct moose_ish_command {
  char *root, *cwd, *executable;
  char arguments[32768], environment[32768];
  int argc, fds[3];
  unsigned timeout_ms;
  atomic_bool cancelled;
};
static pthread_mutex_t owner = PTHREAD_MUTEX_INITIALIZER;
static struct task *supervisor;
static unsigned next_domain;
static int pack(int count, const char *const *values, char *out, size_t bound) {
  size_t used = 0;
  if (count < 0 || count > 1024 || (count && !values))
    return -1;
  for (int i = 0; i < count; i++) {
    if (!values[i])
      return -1;
    size_t n = strnlen(values[i], bound) + 1;
    if (n >= bound - used)
      return -1;
    memcpy(out + used, values[i], n);
    used += n;
  }
  out[used] = 0;
  return 0;
}
moose_ish_command *moose_ish_command_create(const moose_ish_options *o) {
  if (!o || !o->root || o->root[0] != '/' || !o->cwd || o->cwd[0] != '/' ||
      o->argc < 1)
    return NULL;
  moose_ish_command *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  for (int i = 0; i < 3; i++)
    c->fds[i] = -1;
  if (pack(o->argc, o->argv, c->arguments, sizeof(c->arguments)) ||
      pack(o->envc, o->env, c->environment, sizeof(c->environment)))
    goto fail;
  c->root = strdup(o->root);
  c->cwd = strdup(o->cwd);
  c->executable = strdup(o->argv[0]);
  if (!c->root || !c->cwd || !c->executable)
    goto fail;
  c->argc = o->argc;
  c->timeout_ms = o->timeout_ms;
  int fds[] = {o->stdin_fd, o->stdout_fd, o->stderr_fd};
  for (int i = 0; i < 3; i++)
    if ((c->fds[i] = dup(fds[i])) < 0)
      goto fail;
  return c;
fail:
  moose_ish_command_destroy(c);
  return NULL;
}
void moose_ish_command_cancel(moose_ish_command *c) {
  if (c)
    atomic_store(&c->cancelled, true);
}
void moose_ish_command_destroy(moose_ish_command *c) {
  if (!c)
    return;
  for (int i = 0; i < 3; i++)
    if (c->fds[i] >= 0)
      close(c->fds[i]);
  free(c->root);
  free(c->cwd);
  free(c->executable);
  free(c);
}
static double milliseconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}
static int attach_stdio(moose_ish_command *c) {
  for (int i = 0; i < 3; i++) {
    struct fd *fd = adhoc_fd_create(&realfs_fdops);
    if (!fd)
      return -12;
    fd->real_fd = dup(c->fds[i]);
    fd->dir = NULL;
    if (fd->real_fd < 0) {
      fd_close(fd);
      return -9;
    }
    current->files->files[i] = fd;
  }
  return 0;
}
int moose_ish_command_run(moose_ish_command *c, moose_ish_result *result) {
  if (!c || !result)
    return -1;
  *result = (moose_ish_result){0};
  int acquired = 0;
  unsigned domain = 0;
  struct mount *command_mount = NULL;
  double admitted_at = milliseconds();
  while (pthread_mutex_trylock(&owner)) {
    if (atomic_load(&c->cancelled)) {
      result->cancelled = 1;
      result->exit_code = 137;
      goto finish;
    }
    if (c->timeout_ms && milliseconds() - admitted_at >= c->timeout_ms) {
      result->timed_out = 1;
      result->exit_code = 137;
      goto finish;
    }
    struct timespec pause = {0, 10000000};
    nanosleep(&pause, NULL);
  }
  acquired = 1;
  if (c->timeout_ms && milliseconds() - admitted_at >= c->timeout_ms) {
    result->timed_out = 1;
    result->exit_code = 137;
    goto finish;
  }
  if (atomic_load(&c->cancelled)) {
    result->cancelled = 1;
    result->exit_code = 137;
    goto finish;
  }
  int err;
  if (!supervisor) {
    /* tmpfs records the creating uid; bootstrap before PID1 exists. */
    struct task bootstrap = {0};
    current = &bootstrap;
    if ((err = do_mount(&tmpfs, "", "", "", 0)) < 0)
      goto error;
    if ((err = become_first_process()) < 0)
      goto error;
    supervisor = current;
    supervisor->thread = pthread_self();
  }
  current = supervisor;
  supervisor->thread = pthread_self();
  domain = ++next_domain;
  supervisor->moose_domain = domain;
  err = mount_root(&fakefs, c->root);
  if (err >= 0) {
    char root_path[] = "";
    command_mount = mount_find(root_path);
    mount_release(command_mount);
  }
  supervisor->moose_domain = 0;
  if (err < 0)
    goto error;
  if ((err = become_new_init_child_domain(domain)) < 0)
    goto error;
  struct task *command_task = current;
  int main_pid = current->pid;
  /* Create only in-guest devices. No procfs, host mount, socket, or inherited
   * fds. */
  if ((err = generic_mkdirat(AT_PWD, "/dev", 0755)) < 0 && err != _EEXIST)
    goto child_error;
  if ((err = generic_mknodat(AT_PWD, "/dev/null", S_IFCHR | 0666,
                            dev_make(MEM_MAJOR, DEV_NULL_MINOR))) < 0 &&
      err != _EEXIST)
    goto child_error;
  if ((err = generic_mknodat(AT_PWD, "/dev/zero", S_IFCHR | 0666,
                            dev_make(MEM_MAJOR, DEV_ZERO_MINOR))) < 0 &&
      err != _EEXIST)
    goto child_error;
  if ((err = generic_mknodat(AT_PWD, "/dev/urandom", S_IFCHR | 0666,
                            dev_make(MEM_MAJOR, DEV_URANDOM_MINOR))) < 0 &&
      err != _EEXIST)
    goto child_error;
  generic_mkdirat(AT_PWD, "/workspace", 0777);
  struct attr mode = make_attr(mode, 0777);
  generic_setattrat(AT_PWD, "/workspace", mode, true);
  struct fd *pwd = generic_open(c->cwd, O_RDONLY_, 0);
  if (IS_ERR(pwd)) {
    err = PTR_ERR(pwd);
    goto child_error;
  }
  fs_chdir(current->fs, pwd);
  if ((err = attach_stdio(c)) < 0)
    goto child_error;
  current->uid = current->euid = current->suid = 501;
  current->gid = current->egid = current->sgid = 501;
  if ((err = do_execve(c->executable, c->argc, c->arguments, c->environment)) <
      0)
    goto child_error;
  if ((err = task_start(command_task)) < 0)
    goto child_error;
  current = supervisor;
  double start = admitted_at;
  int main_done = 0;
  for (;;) {
    int alive = 0;
    if (atomic_load(&c->cancelled))
      result->cancelled = 1;
    if (c->timeout_ms && milliseconds() - start >= c->timeout_ms)
      result->timed_out = 1;
    lock(&pids_lock);
    struct task *main = pid_get_task_zombie(main_pid);
    if (main && main->zombie && !main_done) {
      int status = main->group->doing_group_exit ? main->group->group_exit_code
                                                 : main->exit_code;
      result->exit_code =
          (status & 127) ? 128 + (status & 127) : (status >> 8) & 255;
      main_done = 1;
    }
    for (int pid = 2; pid <= MAX_PID; pid++) {
      struct task *task = pid_get_task_zombie(pid);
      if (!task || task->moose_domain != domain || task->zombie)
        continue;
      alive++;
      if (main_done || result->cancelled || result->timed_out)
        send_signal(task, SIGKILL_, SIGINFO_NIL);
    }
    unlock(&pids_lock);
    /* Reap only after all tasks have stopped, preserving the primary status. */
    if (!alive) {
      while ((int)sys_wait4(-1, 0, 1, 0) > 0) {
      }
      break;
    }
    struct timespec pause = {0, 10000000};
    nanosleep(&pause, NULL);
  }
  if (result->cancelled || result->timed_out)
    result->exit_code = 137;
  goto finish;
child_error:
  result->error = err;
  current = supervisor;
  task_discard_unstarted(command_task);
  goto finish;
error:
  result->error = err;
finish:
  if (command_mount) {
    lock(&mounts_lock);
    int removed = mount_remove(command_mount);
    unlock(&mounts_lock);
    if (removed < 0 && !result->error)
      result->error = removed;
  }
  current = NULL;
  /* Drop command-owned pipe duplicates before returning so pumps observe EOF.
   */
  for (int i = 0; i < 3; i++)
    if (c->fds[i] >= 0) {
      close(c->fds[i]);
      c->fds[i] = -1;
    }
  if (acquired)
    pthread_mutex_unlock(&owner);
  return 0;
}
