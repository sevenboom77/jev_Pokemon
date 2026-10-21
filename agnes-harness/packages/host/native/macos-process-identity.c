/*
 * macos-process-identity: a small, read-only, standalone helper that answers "is this PID
 * alive, and if so, what identifies THIS specific process instance" on macOS.
 *
 * Why a compiled helper at all: unlike Linux, macOS has no readable pseudo-filesystem exposing
 * a process's start time or a stable per-boot identifier. The supported way to ask the kernel
 * is libproc's proc_pidinfo() plus sysctl's kern.bootsessionuuid, both plain C APIs with no Node
 * built-in binding. This helper is deliberately tiny (read-only, no writes, no network, no
 * environment access beyond argv) so it can be trusted as a leaf dependency of the daemon's
 * crash-recovery lock path (see packages/daemon/src/supervisor/owner-lock.ts).
 *
 * Why boot session UUID + start time together, mirroring Linux's boot_id + /proc/PID/stat's
 * ticks-since-boot field jointly provide: proc_bsdinfo's pbi_start_tvsec/pbi_start_tvusec is
 * the process's wall-clock start time. On its own it already distinguishes an old process from
 * a PID that got reused by a new one *within one uptime*, since two processes essentially never
 * start in the same microsecond. Folding in the boot session UUID invalidates any startId
 * captured before a reboot: without it, a stale startId recorded before a reboot could in
 * principle collide with a post-reboot process that happens to start at the same wall-clock
 * instant (the system clock is not guaranteed monotonic across a reboot). This is the same role
 * Linux's /proc/sys/kernel/random/boot_id plays there. kern.boottime is NOT a stable boot
 * identity: its wall-clock estimate changes during clock synchronization while a process lives.
 *
 * Output contract (stdout, exactly one line, well under 256 bytes, ASCII only):
 *   "alive-v2 <boot-session-uuid> <start_sec>.<start_usec>\n"           exit 0
 *   "dead\n"                                                             exit 1
 *   "unknown <single-word-reason>\n"                                     exit 2
 * The TS wrapper (process-identity-macos.ts) treats any exit code other than 0/1/2, or any
 * stdout that fails to parse against the exact shape above, as 'unknown' rather than guessing —
 * an unrecognized answer must never be read as proof of life or death.
 */
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>

/* Reason tokens are fixed, single words (no spaces/newlines) so the TS side can split on
 * whitespace without worrying about embedded delimiters or needing to escape anything. */
static int report_unknown(const char *reason) {
  printf("unknown %s\n", reason);
  return 2;
}

int main(int argc, char **argv) {
  if (argc != 2) return report_unknown("usage");

  /* Reject anything that is not a plain positive-integer PID before touching any OS API, mirroring
   * the TS-side validation (pid <= 0 or > 2^31-1 is rejected before even spawning this helper).
   * pid_t is a signed 32-bit int on Darwin, so INT32_MAX is the real ceiling. */
  errno = 0;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 0 || parsed > 2147483647L)
    return report_unknown("bad-pid");
  pid_t pid = (pid_t)parsed;

  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  errno = 0;
  int ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (ret <= 0) {
    /* proc_pidinfo's documented contract: 0/negative return with errno == ESRCH means no such
     * process. Any other failure (e.g. EPERM against a privileged process) must stay unknown —
     * it proves nothing about whether the PID is alive or dead. */
    if (errno == ESRCH) {
      printf("dead\n");
      return 1;
    }
    return report_unknown(errno == EPERM ? "eperm" : "pidinfo-failed");
  }
  if (ret != (int)sizeof(info))
    /* A short read means the kernel returned less than the struct this binary was built against
     * expects (e.g. an SDK/kernel version mismatch); parsing partial memory as real fields would
     * be worse than refusing to answer. */
    return report_unknown("short-read");

  char boot_uuid[37] = {0};
  size_t size = sizeof(boot_uuid);
  if (sysctlbyname("kern.bootsessionuuid", boot_uuid, &size, NULL, 0) != 0 ||
      size != sizeof(boot_uuid) || boot_uuid[36] != '\0')
    return report_unknown("bootuuid-unavailable");
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (boot_uuid[i] != '-') return report_unknown("bootuuid-malformed");
    } else if (!((boot_uuid[i] >= '0' && boot_uuid[i] <= '9') ||
                 (boot_uuid[i] >= 'A' && boot_uuid[i] <= 'F') ||
                 (boot_uuid[i] >= 'a' && boot_uuid[i] <= 'f'))) {
      return report_unknown("bootuuid-malformed");
    }
  }

  printf(
      "alive-v2 %s %llu.%06llu\n",
      boot_uuid,
      (unsigned long long)info.pbi_start_tvsec,
      (unsigned long long)info.pbi_start_tvusec);
  return 0;
}
