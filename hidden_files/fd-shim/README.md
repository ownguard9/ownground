# Sandbox fd-limit shim (test environment only)

The sandbox binary (`neard` 2.14.0) refuses to start when the container's
hard RLIMIT_NOFILE is 4096 (it demands 65535, and the container cap cannot
be raised — not even as root). This `LD_PRELOAD` shim makes `setrlimit` /
`getrlimit` report 65535 for RLIMIT_NOFILE so the sandbox starts; the real
cap stays 4096, which is plenty for these small tests.

Build: `gcc -shared -fPIC -o setrlimit_shim.so setrlimit_shim.c -ldl`
Run tests with: `LD_PRELOAD=$PWD/hidden_files/fd-shim/setrlimit_shim.so`
plus `NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox`.

It touches nothing in the contract or the tests — only the sandbox process
startup check.
