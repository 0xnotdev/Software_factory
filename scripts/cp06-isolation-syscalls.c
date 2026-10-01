#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "CP-06 isolation syscall probe currently supports Linux x86-64 only"
#endif

static void result(const char *name, long value) {
  printf("%s=%ld:%d\n", name, value, errno);
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int namespace_fd = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  if (namespace_fd < 0) return 70;

  errno = 0;
  result("setns", syscall(SYS_setns, namespace_fd, 0));
  errno = 0;
  result("unshare", syscall(SYS_unshare, CLONE_NEWUSER));
  errno = 0;
  long child = syscall(SYS_clone, (unsigned long)(CLONE_NEWUSER | SIGCHLD), 0, 0, 0, 0);
  if (child == 0) _exit(0);
  result("clone", child);
#ifdef SYS_clone3
  struct clone_args arguments = {.flags = CLONE_NEWUSER, .exit_signal = SIGCHLD};
  errno = 0;
  child = syscall(SYS_clone3, &arguments, sizeof(arguments));
  if (child == 0) _exit(0);
  result("clone3", child);
#endif
  errno = 0;
  result("mount", syscall(SYS_mount, argv[1], argv[1], 0, MS_REMOUNT | MS_BIND, 0));
  errno = 0;
  result("umount2", syscall(SYS_umount2, argv[1], 0));
  close(namespace_fd);
  return 0;
}
