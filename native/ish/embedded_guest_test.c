/* Freestanding i386 Linux fixture: real guest syscalls, no host/library mocks.
 */
typedef unsigned long u32;
static __attribute__((always_inline)) inline int
call6(int n, int a, int b, int c, int d, int e, int f) {
  register int sixth __asm__("ebp") = f;
  __asm__ volatile("int $0x80"
                   : "+a"(n)
                   : "b"(a), "c"(b), "d"(c), "S"(d), "D"(e), "r"(sixth)
                   : "memory", "cc");
  return n;
}
static void stop(int code) {
  call6(1, code, 0, 0, 0, 0, 0);
  for (;;) {
  }
}
#define CHECK(value, code)                                                     \
  do {                                                                         \
    if (!(value))                                                              \
      stop(code);                                                              \
  } while (0)
void _start(void) {
  const int limit = 16 * 1024 * 1024;
  const char path[] = "resource-syscalls";
  int fd = call6(5, (int)path, 0100 | 02 | 01000, 0600, 0, 0, 0);
  CHECK(fd >= 0, 10);
  CHECK(call6(19, fd, limit - 1, 0, 0, 0, 0) == limit - 1, 11);
  CHECK(call6(4, fd, (int)"x", 1, 0, 0, 0) == 1, 12);
  CHECK(call6(4, fd, (int)"x", 1, 0, 0, 0) == -27, 13);
  CHECK(call6(181, fd, (int)"x", 1, limit, 0, 0) == -27, 14);
  struct {
    const char *base;
    u32 size;
  } vector = {(const char *)"x", 1};
  CHECK(call6(146, fd, (int)&vector, 1, 0, 0, 0) == -27, 15);
  CHECK(call6(194, fd, limit + 1, 0, 0, 0, 0) == -27, 16);
  CHECK(call6(193, (int)path, limit + 1, 0, 0, 0, 0) == -27, 17);
  call6(6, fd, 0, 0, 0, 0, 0);
  const char append_path[] = "resource-append";
  int append_fd =
      call6(5, (int)append_path, 0100 | 02 | 01000 | 02000, 0600, 0, 0, 0);
  CHECK(append_fd >= 0, 27);
  CHECK(call6(181, append_fd, (int)"x", 1, 32 * 1024 * 1024, 0, 0) == -27, 28);
  call6(6, append_fd, 0, 0, 0, 0, 0);
  CHECK(call6(192, 0, 300 * 1024 * 1024, 3, 0x22, -1, 0) == -12, 18);
  int old = call6(45, 0, 0, 0, 0, 0, 0);
  CHECK(call6(45, old + 300 * 1024 * 1024, 0, 0, 0, 0, 0) == old, 19);
  int small = call6(192, 0, 1024 * 1024, 3, 0x22, -1, 0);
  CHECK((u32)small < (u32)-4095, 20);
  CHECK(call6(91, small, 1024 * 1024, 0, 0, 0, 0) == 0, 21);
  int count = 0;
  for (int i = 0; i < 40; i++) {
    int child = call6(2, 0, 0, 0, 0, 0, 0);
    if (child == 0)
      for (;;)
        call6(29, 0, 0, 0, 0, 0, 0);
    if (child < 0) {
      CHECK(child == -11 && count == 31, 22);
      break;
    }
    count++;
  }
  CHECK(count == 31, 23);
  CHECK(call6(37, -1, 9, 0, 0, 0, 0) == 0, 24);
  while (call6(114, -1, 0, 0, 0, 0, 0) > 0) {
  }
  count = 0;
  for (int i = 0; i < 40; i++) {
    int child = call6(2, 0, 0, 0, 0, 0, 0);
    if (child == 0)
      stop(0);
    if (child < 0) {
      CHECK(child == -11 && count == 31, 25);
      break;
    }
    count++;
    struct {
      int sec, nsec;
    } delay = {0, 10000000};
    call6(162, (int)&delay, 0, 0, 0, 0, 0);
  }
  CHECK(count == 31, 26);
  call6(4, 1, (int)"native-resource-syscalls-ok\n", 28, 0, 0, 0);
  stop(0);
}
