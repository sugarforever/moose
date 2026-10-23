// Preserve upstream header prerequisites (fs/path.h is not standalone).
// clang-format off
#include <stdio.h>
#include <string.h>
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include "fs/real.h"
#include "fs/path.h"
#include "probe.h"

// clang-format on

/* Avoid upstream CLI's unbounded 4096-byte argv copy and host env lookup. */
static int pack(int count, const char *const values[], char *out, size_t size) {
  size_t offset = 0;
  for (int i = 0; i < count; i++) {
    size_t len = strlen(values[i]) + 1;
    if (len >= size - offset)
      return -1;
    memcpy(out + offset, values[i], len);
    offset += len;
  }
  out[offset] = 0;
  return 0;
}

int moose_ish_probe_boot(const char *root, const char *cwd, int argc,
                         const char *const argv[], int envc,
                         const char *const env[]) {
  if (argc < 1 || envc < 0 || cwd[0] != '/')
    return -1;
  char arguments[32768] = {0}, environment[32768] = {0};
  if (pack(argc, argv, arguments, sizeof(arguments)) ||
      pack(envc, env, environment, sizeof(environment)))
    return -1;
  int err = mount_root(&fakefs, root);
  if (err < 0)
    return err;
  err = become_first_process();
  if (err < 0)
    return err;
  current->thread = pthread_self();
  struct fd *pwd = generic_open(cwd, O_RDONLY_, 0);
  if (IS_ERR(pwd))
    return PTR_ERR(pwd);
  fs_chdir(current->fs, pwd);
  err = create_piped_stdio();
  if (err < 0)
    return err;
  create_some_device_nodes();
  err = do_mount(&procfs, "proc", "/proc", "", 0);
  if (err < 0)
    return err;
  err = do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
  if (err < 0)
    return err;
  err = do_execve(argv[0], argc, arguments, environment);
  if (err < 0)
    return err;
  task_run_current();
  return -1;
}
