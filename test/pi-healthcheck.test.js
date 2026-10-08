import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const checker = new URL("../scripts/pi-healthcheck.sh", import.meta.url).pathname;

function runCheck({ active = true, failedRequests = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "inventory-healthcheck-"));
  const calls = join(dir, "calls");
  const counter = join(dir, "counter");
  writeFileSync(counter, "0");
  writeFileSync(
    join(dir, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> "$CALLS"
if [ "$1" = is-active ] && [ "$ACTIVE" = 0 ]; then exit 3; fi
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh
echo "curl $*" >> "$CALLS"
count=$(cat "$COUNTER")
count=$((count + 1))
echo "$count" > "$COUNTER"
if [ "$count" -le "$FAILED_REQUESTS" ]; then exit 28; fi
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const result = spawnSync("sh", [checker], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls,
        COUNTER: counter,
        ACTIVE: active ? "1" : "0",
        FAILED_REQUESTS: String(failedRequests),
      },
    });
    return {
      result,
      calls: readFileSync(calls, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Pi health check leaves a healthy or intentionally stopped service alone", () => {
  for (const active of [true, false]) {
    const { result, calls } = runCheck({ active });
    assert.equal(result.status, 0);
    assert.equal(calls.filter((call) => call.startsWith("curl ")).length, active ? 1 : 0);
    assert.equal(calls.some((call) => call.includes(" restart ")), false);
  }
});

test("Pi health check retries a short stall and restarts after two failures", () => {
  const recovered = runCheck({ failedRequests: 1 });
  assert.equal(recovered.result.status, 0);
  assert.equal(recovered.calls.filter((call) => call.startsWith("curl ")).length, 2);
  assert.equal(recovered.calls.some((call) => call.includes(" restart ")), false);

  const stalled = runCheck({ failedRequests: 2 });
  assert.equal(stalled.result.status, 0);
  assert.equal(stalled.calls.filter((call) => call.startsWith("curl ")).length, 2);
  assert.equal(stalled.calls.at(-1), "systemctl restart inventory-management.service");
});
