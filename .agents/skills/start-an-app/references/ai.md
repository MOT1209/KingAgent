# AI features (AI SDK + OpenRouter)

Last verified: 2026-07-21

**Purpose:** Give the app AI abilities (chat, text generation) through the AI SDK, with OpenRouter as the provider so one API key unlocks many models.

> **Read the `ai-sdk` skill before writing any of this.** Step 2a installed it: the AI SDK maintainers' own documentation, shipped from the same repository as the package. On function names, streaming, tool calling, `useChat`, and which import comes from where it outranks this file and anything found by searching — this area moves faster than most. This file owns the provider choice, the route, and how a feature meets the app's auth and log.

## Install

```bash
pnpm add ai @ai-sdk/react @openrouter/ai-sdk-provider
```

Tell the user: create a free key at https://openrouter.ai/keys, then append to `.env`:

```
OPENROUTER_API_KEY=<their key>
OPENROUTER_MODEL=anthropic/claude-sonnet-5
```

Keeping the model in `.env` means they can swap models later without touching code.

## Configure

Provider helper `src/lib/ai.ts`:

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
export const model = openrouter(process.env.OPENROUTER_MODEL!);
```

Chat endpoint `src/app/api/chat/route.ts`:

```ts
import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { model } from "@/lib/ai";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({ model, messages: convertToModelMessages(messages) });
  return result.toUIMessageStreamResponse();
}
```

On the client, build the chat UI with `useChat` from `@ai-sdk/react` pointed at `/api/chat`. Shape the feature to the interview: a support-style chat, a "generate description" button (use `generateText` server-side for one-shot generations), or whatever the user actually asked for — a generic chatbot page is the fallback, not the goal.

Set the system prompt from the interview so the AI knows what app it lives in.

## Verify

- With a real key in `.env`, sending one message returns a streamed reply.
- The AI feature is reachable from the app's navigation, not orphaned.
- Without a key, the app still runs and the AI feature shows a friendly "add your OpenRouter key" notice instead of crashing.
