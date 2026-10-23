/* Moose's embedding API for pinned iSH; see native/ish/NOTICE.md for licensing.
 */
#ifndef MOOSE_ISH_EMBEDDED_H
#define MOOSE_ISH_EMBEDDED_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct moose_ish_command moose_ish_command;
typedef struct {
  const char *root; /* absolute fakefs data directory; bridge clones full root
                       incl metadata */
  const char *cwd;  /* absolute guest directory */
  int argc;
  const char *const *argv;
  int envc;
  const char *const *env;
  int stdin_fd, stdout_fd,
      stderr_fd;       /* borrowed; core duplicates, never changes host stdio */
  unsigned timeout_ms; /* zero means no timeout; includes queue admission */
} moose_ish_options;
typedef struct {
  int exit_code; /* shell convention: 128 + signal */
  int cancelled;
  int timed_out;
  int error; /* negative guest errno for setup failures */
} moose_ish_result;
/* Copies all options; NULL on invalid arguments/allocation failure. */
moose_ish_command *moose_ish_command_create(const moose_ish_options *options);
/* Blocking, safe on a dedicated pthread. All commands serialize process-wide.
 */
int moose_ish_command_run(moose_ish_command *command, moose_ish_result *result);
/* Thread safe, including before run; destroys no host threads/processes. */
void moose_ish_command_cancel(moose_ish_command *command);
/* Only after run returns (or before run starts). */
void moose_ish_command_destroy(moose_ish_command *command);
#ifdef __cplusplus
}
#endif
#endif
