import { appendFileSync, readFileSync } from "node:fs";
const [pidfile, mode, file] = process.argv.slice(2);
appendFileSync(pidfile, `${process.pid}\n`);
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "error") process.exit(2);
else process.stdout.write(readFileSync(file, "utf8"));
