#pragma once
/* Feasibility only: one kernel boot per host process. Not a multi-tenant API.
 */
int moose_ish_probe_boot(const char *root, const char *cwd, int argc,
                         const char *const argv[], int envc,
                         const char *const env[]);
