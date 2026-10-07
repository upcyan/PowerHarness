#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Single-threaded subreaper. Never reap between reading our direct-child PIDs
 * and signalling them: unreaped children reserve their PIDs, so there is no
 * check/kill PID reuse window. No host-wide scan or late process-group signal.
 * The completion receipt is written only after waitpid reports ECHILD. */
static volatile sig_atomic_t stop_requested = 0;
static volatile sig_atomic_t force_requested = 0;
static void request_stop(int sig) {
    stop_requested = 1;
    if (sig == SIGUSR2) force_requested = 1;
}
static void receipt(const char *nonce, const char *kind, int value) {
    char line[160];
    int length = snprintf(line, sizeof(line), "FNOSCLI1 %s %s %d\n", nonce, kind, value);
    if (length > 0 && (size_t)length < sizeof(line)) {
        ssize_t result;
        do { result = write(3, line, (size_t)length); } while (result < 0 && errno == EINTR);
    }
}
static int valid_nonce(const char *value) {
    if (strlen(value) != 32) return 0;
    for (int i = 0; i < 32; i++) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
    return 1;
}
static void signal_children(int sig) {
    char file[96], buffer[65537];
    snprintf(file, sizeof(file), "/proc/self/task/%ld/children", (long)getpid());
    int fd = open(file, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return; /* Fail closed: no receipt while children remain. */
    ssize_t length;
    do { length = read(fd, buffer, sizeof(buffer) - 1); } while (length < 0 && errno == EINTR);
    close(fd);
    if (length <= 0) return;
    buffer[length] = '\0';
    /* A truncated snapshot may end in the middle of a PID. Drop that token.
     * Full chunks are repeatedly processed; ECHILD, not this scan, is proof. */
    if ((size_t)length == sizeof(buffer) - 1) {
        while (length > 0 && buffer[length - 1] != ' ') length--;
        buffer[length] = '\0';
    }
    char *cursor = buffer;
    while (*cursor) {
        char *end;
        long pid = strtol(cursor, &end, 10);
        if (end == cursor || pid <= 1 || pid > 2147483647L) break;
        kill((pid_t)pid, sig);
        cursor = end;
        while (*cursor == ' ') cursor++;
    }
}
int main(int argc, char **argv) {
    if (argc < 3 || !valid_nonce(argv[1])) return 125;
    const char *nonce = argv[1];
    struct sigaction action = {0};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0 ||
        sigaction(SIGUSR2, &action, NULL) < 0 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) {
        receipt(nonce, "setup", errno); return 125;
    }
    signal(SIGPIPE, SIG_IGN);
    pid_t parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0) { receipt(nonce, "setup", errno); return 125; }
    if (getppid() != parent || parent == 1) { receipt(nonce, "setup", ECANCELED); return 125; }
    int errors[2];
    if (pipe2(errors, O_CLOEXEC | O_NONBLOCK) < 0) { receipt(nonce, "setup", errno); return 125; }
    pid_t primary = fork();
    if (primary < 0) { receipt(nonce, "setup", errno); close(errors[0]); close(errors[1]); return 125; }
    if (primary == 0) {
        close(errors[0]);
        close(3); /* The executed CLI can never inherit the receipt descriptor. */
        struct sigaction normal = {0};
        normal.sa_handler = SIG_DFL; sigemptyset(&normal.sa_mask);
        sigaction(SIGTERM, &normal, NULL); sigaction(SIGINT, &normal, NULL);
        sigaction(SIGUSR2, &normal, NULL); sigaction(SIGPIPE, &normal, NULL);
        setpgid(0, 0);
        execvp(argv[2], &argv[2]);
        int error = errno;
        ssize_t ignored = write(errors[1], &error, sizeof(error)); (void)ignored;
        _exit(127);
    }
    close(errors[1]);
    setpgid(primary, primary);
    int primary_done = 0, primary_status = 0, exec_error = 0, term_sent = 0;
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 20000000 };
    for (;;) {
        // Parent death removes the API grace escalator: force cleanup ourselves.
        if (getppid() != parent) { stop_requested = 1; force_requested = 1; }
        int status;
        pid_t waited;
        do {
            waited = waitpid(-1, &status, WNOHANG);
            if (waited == primary) { primary_status = status; primary_done = 1; }
        } while (waited > 0);
        if (waited < 0 && errno == ECHILD) {
            ssize_t count = read(errors[0], &exec_error, sizeof(exec_error));
            close(errors[0]);
            if (!primary_done) return 125; /* No fabricated receipt. */
            if (count == sizeof(exec_error) && exec_error > 0) { receipt(nonce, "exec", exec_error); return 127; }
            if (WIFEXITED(primary_status)) { int code = WEXITSTATUS(primary_status); receipt(nonce, "exit", code); return code; }
            if (WIFSIGNALED(primary_status)) { int sig = WTERMSIG(primary_status); receipt(nonce, "signal", sig); return 128 + sig; }
            return 125;
        }
        /* After primary exits, background descendants must not keep mutating
         * the profile. Kill only currently adopted children, then reap again.
         * API grace escalation requests SIGUSR2, never kills this reaper. */
        if (primary_done || force_requested) signal_children(SIGKILL);
        else if (stop_requested && !term_sent) { signal_children(SIGTERM); term_sent = 1; }
        nanosleep(&pause, NULL);
    }
}
