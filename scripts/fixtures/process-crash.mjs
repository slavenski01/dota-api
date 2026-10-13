import { runBoundedProcess } from "@dota/jobs";
await runBoundedProcess({ command: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)", process.argv[2]] }, new AbortController().signal);
