import { hashPassword } from "../src/server/auth/core";

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!process.argv.includes("--stdin")) throw new Error("Use an interactive terminal, or explicitly pass --stdin to read a password from a pipe.");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 1026) throw new Error("Password is too long.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write("Password (at least 16 characters, input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let bytes: number[] = [];
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) { finish(); reject(new Error("Cancelled.")); return; }
          if (byte === 13 || byte === 10) { finish(); resolve(Buffer.from(bytes).toString("utf8")); return; }
          if (byte === 127 || byte === 8) bytes.pop();
          else if (byte >= 32) bytes.push(byte);
          if (bytes.length > 1024) { finish(); reject(new Error("Password is too long.")); return; }
        }
      };
      const finish = () => { process.stdin.off("data", onData); };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

readPassword().then(hashPassword).then((encoded) => process.stdout.write(`${encoded}\n`)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Password hash failed."}\n`);
  process.exitCode = 1;
});
