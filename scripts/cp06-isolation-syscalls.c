#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <linux/securebits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "CP-06 isolation syscall probe currently supports Linux x86-64 only"
#endif

static void result(const char *prefix, const char *name, long value) {
  int error = errno;
  printf("%s%s=%ld:%d\n", prefix, name, value, error);
}

static void observations(const char *prefix) {
  printf("%ssecurebits=%d\n", prefix, prctl(PR_GET_SECUREBITS));
  printf("%sNoNewPrivs=%d\n", prefix, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
  printf("%sSeccomp=%d\n", prefix, prctl(PR_GET_SECCOMP, 0, 0, 0, 0));
  FILE *status = fopen("/proc/self/status", "r");
  if (!status) _exit(70);
  char line[256], name[32], value[64];
  while (fgets(line, sizeof(line), status)) {
    if (sscanf(line, "%31[^:]: %63s", name, value) == 2 &&
        (!strcmp(name, "CapInh") || !strcmp(name, "CapPrm") ||
         !strcmp(name, "CapEff") || !strcmp(name, "CapBnd") || !strcmp(name, "CapAmb"))) {
      printf("%s%s=%s\n", prefix, name, value);
    }
  }
  fclose(status);
}

static void attempts(const char *prefix, const char *mount_path, pid_t target,
                     uintptr_t address, int target_fd) {
  int namespace_fd = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  if (namespace_fd < 0) _exit(70);
  errno = 0;
  result(prefix, "setns", syscall(SYS_setns, namespace_fd, 0));
  errno = 0;
  result(prefix, "unshare", syscall(SYS_unshare, CLONE_NEWUSER));
  errno = 0;
  long child = syscall(SYS_clone, (unsigned long)(CLONE_NEWUSER | SIGCHLD), 0, 0, 0, 0);
  if (child == 0) _exit(0);
  result(prefix, "clone", child);
  if (child > 0) waitpid((pid_t)child, NULL, 0);
  struct clone_args arguments = {.flags = CLONE_NEWUSER, .exit_signal = SIGCHLD};
  errno = 0;
  child = syscall(SYS_clone3, &arguments, sizeof(arguments));
  if (child == 0) _exit(0);
  result(prefix, "clone3", child);
  if (child > 0) waitpid((pid_t)child, NULL, 0);
  errno = 0;
  result(prefix, "mount", syscall(SYS_mount, mount_path, mount_path, 0, MS_REMOUNT | MS_BIND, 0));
  errno = 0;
  result(prefix, "umount2", syscall(SYS_umount2, mount_path, 0));
  close(namespace_fd);

  errno = 0;
  long attached = ptrace(PTRACE_ATTACH, target, NULL, NULL);
  result(prefix, "ptrace_attach", attached);
  if (attached == 0) { waitpid(target, NULL, 0); ptrace(PTRACE_DETACH, target, NULL, NULL); }
  errno = 0;
  long seized = ptrace(PTRACE_SEIZE, target, NULL, NULL);
  result(prefix, "ptrace_seize", seized);
  if (seized == 0) { kill(target, SIGSTOP); waitpid(target, NULL, WUNTRACED); ptrace(PTRACE_DETACH, target, NULL, NULL); }
  char dummy[] = "DUMMY FIXTURE ONLY";
  struct iovec local = {.iov_base = dummy, .iov_len = sizeof(dummy)};
  struct iovec remote = {.iov_base = (void *)address, .iov_len = sizeof(dummy)};
  errno = 0;
  result(prefix, "process_vm_readv", process_vm_readv(target, &local, 1, &remote, 1, 0));
  errno = 0;
  result(prefix, "process_vm_writev", process_vm_writev(target, &local, 1, &remote, 1, 0));
  int pidfd = (int)syscall(SYS_pidfd_open, target, 0);
  printf("%spidfd_open=%s\n", prefix, pidfd >= 0 ? "opened" : "failed");
  if (pidfd >= 0) {
    errno = 0;
    int copied = (int)syscall(SYS_pidfd_getfd, pidfd, target_fd, 0);
    result(prefix, "pidfd_getfd", copied);
    if (copied >= 0) close(copied);
    close(pidfd);
  }
  char path[64];
  snprintf(path, sizeof(path), "/proc/%ld/mem", (long)target);
  errno = 0;
  int memory = open(path, O_RDWR | O_CLOEXEC);
  result(prefix, "proc_mem", memory);
  if (memory >= 0) close(memory);
  observations(prefix);
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  alarm(10);
  int ready[2], stop[2];
  if (pipe2(ready, O_CLOEXEC) || pipe2(stop, O_CLOEXEC)) return 70;
  pid_t owner = getpid();
  pid_t target = fork();
  if (target < 0) return 70;
  if (target == 0) {
    close(ready[0]); close(stop[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != owner ||
        prctl(PR_SET_DUMPABLE, 0)) _exit(70);
    volatile char dummy[] = "DUMMY FIXTURE ONLY";
    uintptr_t address = (uintptr_t)dummy;
    if (write(ready[1], &address, sizeof(address)) != (ssize_t)sizeof(address)) _exit(70);
    close(ready[1]);
    char done;
    if (read(stop[0], &done, 1) != 1) _exit(70);
    const char expected[] = "DUMMY FIXTURE ONLY";
    for (size_t index = 0; index < sizeof(expected); ++index) if (dummy[index] != expected[index]) _exit(71);
    _exit(0);
  }
  close(ready[1]); close(stop[0]);
  uintptr_t address;
  if (read(ready[0], &address, sizeof(address)) != (ssize_t)sizeof(address)) {
    kill(target, SIGKILL); waitpid(target, NULL, 0); return 70;
  }
  close(ready[0]);
  attempts("", argv[1], target, address, stop[0]);
  fflush(stdout);
  pid_t inherited = fork();
  if (inherited == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != owner) _exit(70);
    attempts("inherited_", argv[1], target, address, stop[0]);
    fflush(stdout);
    _exit(0);
  }
  int status = 0;
  int ok = inherited > 0 && waitpid(inherited, &status, 0) == inherited && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  if (write(stop[1], "D", 1) != 1) ok = 0;
  close(stop[1]);
  if (waitpid(target, &status, 0) != target || !WIFEXITED(status) || WEXITSTATUS(status) != 0) ok = 0;
  printf("dummy_target_unchanged=%s\n", ok ? "true" : "false");
  return ok ? 0 : 70;
}
