# Embedded iSH source and license notice

The optional native execution core links iSH, copyright its upstream contributors,
from https://github.com/ish-app/ish at commit
`c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c`.

Upstream `LICENSE.md` specifies GNU GPL version 3 plus the additional terms in
`LICENSE.IOS`. Contributions after the commit identified in `LICENSE.md`, and
identified authors' earlier contributions, are additionally licensed under GPL
version 2. That does not establish a GPLv2-only license for the complete source.
Preserve all upstream source notices and the full upstream license files.

`embedded-policy.patch` is Moose's local modification to that pinned source:
it adds inherited execution domains, isolates mount selection by domain,
prevents guest host mounts, sockets, ptrace, privileged device/chroot operations,
cross-domain signals and cross-process resource-limit changes, and suppresses
setuid/setgid privilege changes at exec. `embedded.c` adds one surviving
supervisor, serialized command startup, explicit descriptors, domain cancellation
and reaping. The builder applies the patch only to a disposable copied source;
the pristine pinned checkout remains unchanged.

Before distributing a linked binary, select a compatible whole-program license,
include complete applicable license texts and notices, and deliver complete
corresponding source with build instructions for the exact kernel, modifications,
frontend and bundled root filesystem packages. `LICENSE.IOS` retains source and
license-text obligations. Alpine packages have their own licenses and sources;
rootfs redistribution requires an additional package source/license manifest.
The current build outputs are local validation artifacts, not a distribution
license determination. See `docs/ios-ish-execution.md` for evidence and limits.

The embedded policy also caps each active domain at 32 owned task slots (processes, threads and unreaped zombies
together), regular guest files at 16 MiB, and combined guest mapping
backing at 256 MiB. Shared COW backing counts once; private copies count when
allocated. Native syscall transfer buffers are separately bounded to 16 MiB,
with at most 1024 vector entries. These are explicit kernel-path checks, not
claims that upstream enforces RLIMIT_AS, RLIMIT_FSIZE, or RLIMIT_NPROC. The
mapping counter does not bound whole-process RSS, emulator/SQLite metadata or
all host allocations. There is no aggregate workspace disk quota. Mounts and
SQLite connections are retired after every command's tasks and descriptors
have been reaped; persistent fakefs files remain on disk.
