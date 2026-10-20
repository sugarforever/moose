#include "kernel/calls.h"
#include "kernel/task.h"
#include "probe.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void exited(struct task *task, int status) {
  if (task->parent)
    return;
  /* Deliberately only valid in a standalone harness, never in Moose. */
  fflush(NULL);
  _Exit((status & 0xff) ? 128 + (status & 0x7f) : status >> 8);
}
int main(int argc, const char *argv[]) {
  if (argc < 5)
    return 64;
  int separator = 3;
  while (separator < argc && strcmp(argv[separator], "--")) {
    if (!strchr(argv[separator], '='))
      return 64;
    separator++;
  }
  if (separator >= argc - 1)
    return 64;
  exit_hook = exited;
  int err = moose_ish_probe_boot(argv[1], argv[2], argc - separator - 1,
                                 argv + separator + 1, separator - 3, argv + 3);
  fprintf(stderr, "iSH probe boot failed: %d\n", err);
  return 70;
}
