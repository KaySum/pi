// Disposable Pi-equivalent parent for parent-death tests. Never kill real Pi.
import { HeadlessDiagnostics } from "../bridge.mjs";
const [cwd, init] = process.argv.slice(2);
const bridge = new HeadlessDiagnostics({ init, onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n") });
try { await bridge.request({ files: ["sample.txt"], timeout_ms: 30000 }, cwd); }
catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
finally { await bridge.close(); }
