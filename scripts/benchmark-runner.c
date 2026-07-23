#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double seconds_between(const struct timespec *start,
                              const struct timespec *end) {
  return (double)(end->tv_sec - start->tv_sec) +
         (double)(end->tv_nsec - start->tv_nsec) / 1000000000.0;
}

static double timeval_seconds(const struct timeval *value) {
  return (double)value->tv_sec + (double)value->tv_usec / 1000000.0;
}

int main(int argc, char **argv) {
  struct timespec start;
  struct timespec end;
  struct rusage usage;
  pid_t child;
  int status;
  long max_rss_kb;

  if (argc < 2) {
    fprintf(stderr, "usage: benchmark-runner command [arg ...]\n");
    return 2;
  }

  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) {
    fprintf(stderr, "clock_gettime(start): %s\n", strerror(errno));
    return 2;
  }

  child = fork();
  if (child < 0) {
    fprintf(stderr, "fork: %s\n", strerror(errno));
    return 2;
  }

  if (child == 0) {
    execvp(argv[1], &argv[1]);
    fprintf(stderr, "execvp(%s): %s\n", argv[1], strerror(errno));
    _exit(127);
  }

  if (wait4(child, &status, 0, &usage) < 0) {
    fprintf(stderr, "wait4: %s\n", strerror(errno));
    return 2;
  }

  if (clock_gettime(CLOCK_MONOTONIC, &end) != 0) {
    fprintf(stderr, "clock_gettime(end): %s\n", strerror(errno));
    return 2;
  }

#ifdef __APPLE__
  max_rss_kb = usage.ru_maxrss / 1024;
#else
  max_rss_kb = usage.ru_maxrss;
#endif

  fprintf(stderr, "bench_wall_s %.6f\n", seconds_between(&start, &end));
  fprintf(stderr, "bench_user_s %.6f\n", timeval_seconds(&usage.ru_utime));
  fprintf(stderr, "bench_sys_s %.6f\n", timeval_seconds(&usage.ru_stime));
  fprintf(stderr, "bench_max_rss_kb %ld\n", max_rss_kb);

  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 2;
}
