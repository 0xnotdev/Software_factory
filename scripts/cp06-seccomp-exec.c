#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
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

static void close_inherited_fds(int retained) {
#ifdef SYS_close_range
  if (retained == 4) {
    close(3);
    if (syscall(SYS_close_range, 5U, ~0U, 0U) == 0) return;
  } else if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
  if (errno != ENOSYS) fail("close_range");
#endif
  long limit = sysconf(_SC_OPEN_MAX);
  if (limit < 0 || limit > 1048576) limit = 1048576;
  for (int fd = 3; fd < limit; ++fd) if (fd != retained) close(fd);
}

/*
 * Descriptor-bound read-only bind mounts for the private setup namespace. The
 * source tree comes from a retained descriptor and the destination is an
 * identity-checked O_PATH descriptor, so no mount input is resolved by name.
 */
static void refuse(const char *message) {
  fprintf(stderr, "%s\n", message);
  _exit(65);
}

static int parse_u64(const char *text, uint64_t *value) {
  char *end = NULL;
  if (text == NULL || text[0] < '0' || text[0] > '9') return -1;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0') return -1;
  *value = (uint64_t)parsed;
  return 0;
}

static int has_identity(int fd, mode_t type, const char *dev, const char *ino) {
  struct stat st;
  uint64_t expected_dev;
  uint64_t expected_ino;
  return parse_u64(dev, &expected_dev) == 0 && parse_u64(ino, &expected_ino) == 0 &&
         fstat(fd, &st) == 0 && (st.st_mode & S_IFMT) == type &&
         (uint64_t)st.st_dev == expected_dev && (uint64_t)st.st_ino == expected_ino;
}

static void require_visible(const char *path, mode_t type, const char *dev, const char *ino) {
  int fd = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || !has_identity(fd, type, dev, ino)) {
    refuse("CP-06 mount destination path identity changed");
  }
  close(fd);
}

static void attach_read_only(int source_fd, unsigned int recursive, int destination_fd) {
  int tree = (int)syscall(SYS_open_tree, source_fd, "",
                          OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH | recursive);
  if (tree < 0) fail("open_tree");
  struct mount_attr attributes = {
      .attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC,
  };
  if (syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH | recursive, &attributes,
              sizeof(attributes)) != 0) {
    fail("mount_setattr");
  }
  if (syscall(SYS_move_mount, tree, "", destination_fd, "",
              MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) != 0) {
    fail("move_mount");
  }
  close(tree);
}

/* fd 3: pinned regular source; fd 4: retained destination parent directory. */
static int bind_file(int argc, char **argv) {
  if (argc != 8 || argv[4][0] == '\0' || strchr(argv[4], '/') != NULL ||
      strcmp(argv[4], ".") == 0 || strcmp(argv[4], "..") == 0) {
    fprintf(stderr, "usage: cp06-seccomp-exec --cp06-bind-file SRC_DEV SRC_INO LEAF DEV INO PATH\n");
    return 64;
  }
  if (!has_identity(3, S_IFREG, argv[2], argv[3])) refuse("CP-06 mount source identity changed");
  int destination = openat(4, argv[4], O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (destination < 0 || !has_identity(destination, S_IFREG, argv[5], argv[6])) {
    refuse("CP-06 mount destination identity changed");
  }
  require_visible(argv[7], S_IFREG, argv[5], argv[6]);
  attach_read_only(3, 0, destination);
  close(destination);
  return 0;
}

/* fd 3: retained directory, bound read-only over itself with its submounts. */
static int bind_tree(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: cp06-seccomp-exec --cp06-bind-tree DEV INO PATH\n");
    return 64;
  }
  if (!has_identity(3, S_IFDIR, argv[2], argv[3])) {
    refuse("CP-06 mount directory identity changed");
  }
  require_visible(argv[4], S_IFDIR, argv[2], argv[3]);
  attach_read_only(3, AT_RECURSIVE, 3);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--cp06-bind-file") == 0) return bind_file(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "--cp06-bind-tree") == 0) return bind_tree(argc, argv);
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
  int retained = -1;
  if (strcmp(argv[1], "--cp06-readonly-fd=4") == 0) {
    struct stat st;
    if (argc < 3 || fstat(4, &st) != 0 || !S_ISREG(st.st_mode) ||
        (fcntl(4, F_GETFL) & O_ACCMODE) != O_RDONLY) return 64;
    retained = 4;
    ++argv;
    --argc;
  }
  close_inherited_fds(retained);
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
