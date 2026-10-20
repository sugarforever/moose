/* Standalone adapter for testing the same embedded core used by the native
 * module. */
#include "embedded.h"
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 5)
    return 125;
  int split = 3;
  while (split < argc &&
         !(argv[split][0] == '-' && argv[split][1] == '-' && !argv[split][2]))
    split++;
  if (split == argc || split + 1 == argc)
    return 125;
  moose_ish_options o = {argv[1],
                         argv[2],
                         argc - split - 1,
                         (const char *const *)argv + split + 1,
                         split - 3,
                         (const char *const *)argv + 3,
                         0,
                         1,
                         2,
                         30000};
  moose_ish_command *c = moose_ish_command_create(&o);
  if (!c)
    return 125;
  moose_ish_result r;
  int error = moose_ish_command_run(c, &r);
  moose_ish_command_destroy(c);
  return error || r.error ? 125 : r.exit_code;
}
