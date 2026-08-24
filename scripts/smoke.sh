#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The current Package source tree, both WebUI pages, and isolated self-tests.
# [OUTPUT]: A truthful PASS/FAIL result for github.termux-os.service.termux-speech.
# [POS]: scripts/smoke.sh in the generated Extension Package.
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
check_node() {
  local file="$1"
  if node --check "$file"; then
    echo "PASS syntax ${file#"$HERE"/}"
  else
    echo "FAIL syntax ${file#"$HERE"/}"
    fail=1
  fi
}
check_node "$HERE/package.mjs"
while IFS= read -r file; do check_node "$file"; done < <(
  find "$HERE/service" "$HERE/web" -type f \( -name '*.mjs' -o -name '*.js' \) | sort
)
node "$HERE/test/self-test.mjs" || fail=1
node "$HERE/test/lifecycle-test.mjs" || fail=1
node "$HERE/test/storage-test.mjs" || fail=1
node "$HERE/test/state-test.mjs" || fail=1
echo "smoke: $([ $fail -eq 0 ] && echo ALL PASS || echo FAILED)"
exit $fail
