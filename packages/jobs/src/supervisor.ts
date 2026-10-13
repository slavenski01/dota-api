// Private watchdog executable. It also survives an abrupt worker exit long enough
// to terminate the process group, so a retried job does not leave an orphan JVM.
import { spawn, execFile } from "node:child_process";
const spec = JSON.parse(process.env.DOTA_PROCESS_SPEC ?? "null");
delete process.env.DOTA_PROCESS_SPEC;
if (!spec || !Number.isInteger(spec.parentPid)) process.exit(74);
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let reason: number | undefined; let killTimer: ReturnType<typeof setTimeout> | undefined;
function kill(signal: NodeJS.Signals): void { if (child.pid) try { process.kill(-child.pid, signal); } catch {} }
function stop(code: number): void {
  if (reason !== undefined) return;
  reason = code; kill("SIGTERM");
  killTimer = setTimeout(() => kill("SIGKILL"), 500);
}
process.on("SIGTERM", () => stop(73)); process.on("SIGINT", () => stop(73));
const deadline = setTimeout(() => stop(70), spec.timeoutMs);
let sampling = false;
const monitor = setInterval(() => {
  if (process.ppid !== spec.parentPid) stop(72);
  if (sampling || !child.pid) return;
  sampling = true;
  execFile("/bin/ps", ["-axo", "pgid=,rss="], { timeout: 1000, maxBuffer: 1024 ** 2 }, (error, stdout) => {
    sampling = false;
    if (error) { stop(71); return; }
    const bytes = stdout.trim().split("\n").reduce((sum, line) => {
      const [group, rss] = line.trim().split(/\s+/).map(Number);
      return sum + (group === child.pid ? (rss ?? 0) * 1024 : 0);
    }, 0);
    if (bytes > spec.memoryBytes) stop(71);
  });
}, 250);
child.once("error", () => { reason = 74; });
child.once("exit", () => {
  // Descendants must not outlive the command, including on a successful exit.
  kill("SIGTERM");
  killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
});
child.once("close", code => {
  clearInterval(monitor); clearTimeout(deadline);
  // Keep the final kill timer: descendants may have closed stdout but still run.
  process.stdin.unpipe(child.stdin); process.stdin.destroy();
  process.exitCode = reason ?? code ?? 1;
});
