#define _GNU_SOURCE
#include <errno.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "CP-06 isolation helper currently supports Linux x86-64 only"
#endif

typedef void *scmp_filter_ctx;
struct scmp_arg_cmp {
  unsigned int arg;
  int op;
  uint64_t datum_a;
  uint64_t datum_b;
};
extern scmp_filter_ctx seccomp_init(uint32_t def_action);
extern int seccomp_rule_add(scmp_filter_ctx, uint32_t, int, unsigned int, ...);
extern int seccomp_rule_add_array(scmp_filter_ctx, uint32_t, int, unsigned int,
                                  const struct scmp_arg_cmp *);
extern int seccomp_load(scmp_filter_ctx);
extern void seccomp_release(scmp_filter_ctx);
extern int seccomp_syscall_resolve_name(const char *);

#define SCMP_ACT_ALLOW 0x7fff0000U
#define SCMP_ACT_ERRNO(x) (0x00050000U | ((x) & 0x0000ffffU))
#define SCMP_CMP_MASKED_EQ 7

static void fail(const char *message) {
  perror(message);
  _exit(70);
}

static void deny(scmp_filter_ctx ctx, const char *name, int error) {
  int nr = seccomp_syscall_resolve_name(name);
  if (nr >= 0 && seccomp_rule_add(ctx, SCMP_ACT_ERRNO(error), nr, 0) < 0) {
    fprintf(stderr, "cannot install seccomp rule for %s\n", name);
    _exit(70);
  }
}

static void close_inherited_fds(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
  if (errno != ENOSYS) fail("close_range");
#endif
  long limit = sysconf(_SC_OPEN_MAX);
  if (limit < 0 || limit > 1048576) limit = 1048576;
  for (int fd = 3; fd < limit; ++fd) close(fd);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: cp06-seccomp-exec COMMAND [ARG...]\n");
    return 64;
  }

  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) fail("PR_SET_PDEATHSIG");
  if (getppid() != parent || parent == 1) {
    fprintf(stderr, "CP-06 supervisor disappeared before isolation\n");
    return 70;
  }
  close_inherited_fds();
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("PR_SET_NO_NEW_PRIVS");

  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (ctx == NULL) {
    fprintf(stderr, "seccomp_init failed\n");
    return 70;
  }
  const char *blocked[] = {
      "mount",          "umount2",          "pivot_root",
      "move_mount",     "open_tree",        "fsopen",
      "fsconfig",       "fsmount",          "fspick",
      "mount_setattr",  "unshare",          "setns",
      "open_by_handle_at", "name_to_handle_at", "ptrace",
      "process_vm_readv", "process_vm_writev", "pidfd_getfd",
      "bpf",            "perf_event_open",  "personality",
      "kexec_load",     "kexec_file_load",
  };
  for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); ++i) {
    deny(ctx, blocked[i], EPERM);
  }

  /* Node/libc can fall back to clone(2), where namespace bits are filtered. */
  deny(ctx, "clone3", ENOSYS);
  int clone_nr = seccomp_syscall_resolve_name("clone");
  const uint64_t namespace_flags[] = {
      CLONE_NEWNS,  CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC,
      CLONE_NEWUSER, CLONE_NEWPID,   CLONE_NEWNET,
  };
  for (size_t i = 0;
       clone_nr >= 0 && i < sizeof(namespace_flags) / sizeof(namespace_flags[0]);
       ++i) {
    struct scmp_arg_cmp comparison = {
        .arg = 0,
        .op = SCMP_CMP_MASKED_EQ,
        .datum_a = namespace_flags[i],
        .datum_b = namespace_flags[i],
    };
    if (seccomp_rule_add_array(ctx, SCMP_ACT_ERRNO(EPERM), clone_nr, 1,
                               &comparison) < 0) {
      fprintf(stderr, "cannot install clone namespace filter\n");
      seccomp_release(ctx);
      return 70;
    }
  }

  if (seccomp_load(ctx) < 0) {
    seccomp_release(ctx);
    fail("seccomp_load");
  }
  seccomp_release(ctx);
  execvp(argv[1], &argv[1]);
  fail("execvp");
}
