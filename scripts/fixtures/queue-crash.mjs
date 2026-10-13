import { startQueue, QUEUE } from "@dota/jobs";
const boss = await startQueue(process.env.TEST_DATABASE_URL, { expireInSeconds: 2, retryDelay: 1 });
const jobs = await boss.fetch(QUEUE);
if (!jobs.length) process.exit(1);
console.log("claimed");
setInterval(() => {}, 1000);
