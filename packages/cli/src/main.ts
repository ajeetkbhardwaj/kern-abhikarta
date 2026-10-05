import { createAgentSession } from "@kern/coding-agent";
import { createLogger } from "@kern/protocol";

async function main() {
  const logger = createLogger("info");
  const cwd = process.cwd();
  const prompt = process.argv.slice(2).join(" ") || "What is in README.md?";
  const { session } = await createAgentSession({ cwd, logger });
  session.subscribe((ev) => {
    if (ev.type === "text_delta") process.stdout.write(ev.delta);
    if (ev.type === "message_end" && ev.message.role === "assistant") process.stdout.write("\n");
  });
  await session.prompt(prompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});