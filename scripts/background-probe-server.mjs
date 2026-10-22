/** Local controlled endpoint for the opt-in Android background probe. Never forwards requests. */
import { createServer } from "node:http";
import { responseEvents } from "../src/dev/controlled-sse.ts";
let requests = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    response.writeHead(400).end();
    return;
  }
  const step = body.input?.some(
    (entry) => entry.type === "function_call_output",
  )
    ? 1
    : 0;
  const delay = Math.min(
    650000,
    Number(/delay=(\d+)/.exec(JSON.stringify(body.input))?.[1] ?? 15000),
  );
  const id = ++requests;
  console.log(JSON.stringify({ event: "request", id, step, at: Date.now() }));
  const events = responseEvents(
    step,
    [
      {
        name: "write",
        arguments: {
          path: "background.txt",
          content: "native background tool",
        },
      },
    ],
    "Native background passed",
  );
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  response.write(events.slice(0, 50));
  const timer = setTimeout(
    () => {
      response.end(events.slice(50));
      console.log(JSON.stringify({ event: "completed", id, at: Date.now() }));
    },
    step === 0 ? delay : 0,
  );
  response.on("close", () => {
    clearTimeout(timer);
    console.log(JSON.stringify({ event: "closed", id, at: Date.now() }));
  });
});
server.listen(8106, "127.0.0.1", () =>
  console.log("Controlled background probe server on 8106"),
);
