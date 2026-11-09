#define _GNU_SOURCE
#include <stddef.h>
#include <sys/resource.h>
#include <dlfcn.h>
int setrlimit(__rlimit_resource_t resource, const struct rlimit *rlim) {
    if (resource == RLIMIT_NOFILE) return 0;
    static int (*real_fn)(__rlimit_resource_t, const struct rlimit *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "setrlimit");
    return real_fn(resource, rlim);
}
int getrlimit(__rlimit_resource_t resource, struct rlimit *rlim) {
    if (resource == RLIMIT_NOFILE) { rlim->rlim_cur = 65535; rlim->rlim_max = 65535; return 0; }
    static int (*real_fn)(__rlimit_resource_t, struct rlimit *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "getrlimit");
    return real_fn(resource, rlim);
}
int setrlimit64(__rlimit_resource_t resource, const struct rlimit64 *rlim) {
    if (resource == RLIMIT_NOFILE) return 0;
    static int (*real_fn)(__rlimit_resource_t, const struct rlimit64 *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "setrlimit64");
    return real_fn(resource, rlim);
}
int getrlimit64(__rlimit_resource_t resource, struct rlimit64 *rlim) {
    if (resource == RLIMIT_NOFILE) { rlim->rlim_cur = 65535; rlim->rlim_max = 65535; return 0; }
    static int (*real_fn)(__rlimit_resource_t, struct rlimit64 *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "getrlimit64");
    return real_fn(resource, rlim);
}
