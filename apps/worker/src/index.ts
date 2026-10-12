const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("Usage: worker [--check]");
  process.exitCode = 2;
} else {
  const log = (event: string, details: Record<string, unknown> = {}): void => {
    console.log(JSON.stringify({ service: "worker", event, mode: "scaffold", ...details }));
  };

  if (args[0] === "--check") {
    log("worker.check", { queueConnected: false });
  } else {
    // Keeps the scaffold alive until queue consumption is implemented in E02.
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = (signal: NodeJS.Signals): void => {
      clearInterval(keepAlive);
      log("worker.stopped", { signal });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    log("worker.started", { queueConnected: false });
  }
}
