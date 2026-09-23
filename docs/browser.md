# Browser (`src/core/browser/`)

The browser is the one capability that reaches the live web, so it is the one
capability where "an agent may do this" has to be answerable in named pieces
rather than as one switch. This subsystem is that gate.

```
BrowserControl          who is driving a session — an agent or a person
browser:* tools         the actions, registered against the existing ToolManager
io.browser.host         the injected adapter that owns the real engine
```

## Why it lives in `core/`

The Electron app already has a browser (`src/main/browser-*.js`, Playwright MCP
over a scoped CDP transport). What it did not have was a place where a *rule*
about browser use could be stated: which actions exist, how risky each one is,
and what happens when a person takes the wheel. That rule belongs in the
platform, not in a window.

The tools register through the same `ToolManager` as `fs:read` and
`terminal:run`, so the existing gates apply unchanged:

| Gate | What it does here |
| --- | --- |
| `tools/permissions.js` | the agent's granted levels decide which browser actions it may call at all |
| `policy` | a document that says `deny browser.type` means it |
| `ApprovalManager` | every `DESTRUCTIVE` browser action becomes one auditable human decision |
| `ToolManager` | timeouts, abort, and classified, emitted failures |

No second permission system was invented for the browser.

## The actions

| Tool | Policy action | Level | Per-call approval |
| --- | --- | --- | --- |
| `browser:navigate` | `browser.navigate` | safe | — |
| `browser:read` | `browser.read` | read_only | — |
| `browser:screenshot` | `browser.read` | read_only | — |
| `browser:click` | `browser.click` | moderate | — |
| `browser:type` | `browser.type` | moderate | — |
| `browser:download` | `browser.download` | moderate | yes |
| `browser:clipboard` | `browser.clipboard` | moderate | yes |
| `browser:upload` | `browser.upload` | destructive | yes |
| `browser:authenticate` | `browser.authentication` | destructive | yes |
| `browser:submit` | `browser.external_submit` | destructive | yes |

The three `destructive` rows are the judgement worth stating out loud: an upload
sends local files to someone else's server, authenticating acts as the person,
and a submit stops being a read and starts changing state on a system nobody
here owns. `browser:authenticate` never hands the agent a credential — the host
holds them; the tool names an account, not a password.

## Take control / return control

`BrowserControl` owns a single fact per session: **who is driving**.

```js
platform.browser.open('tab-1', { agentId: 'agent-7' });   // a host opens a tab
platform.browser.takeControl('tab-1', { reason: 'entering a card number' });
platform.browser.get('tab-1').owner;                      // 'human'
platform.browser.returnControl('tab-1');                  // back to the agent
```

The rule §23 asks for — *the agent must stop interacting with that session until
control is returned* — is enforced **inside** the tool call, after any approval
has already been granted. A UI-only rule would be a suggestion: an action that
was already queued would land while the person was typing. Here the refused call
comes back as `BROWSER_HUMAN_CONTROL`, and it never reaches the page.

Two other properties fall out of the same place:

- **A session belongs to one agent at a time.** A second agent acting on someone
  else's tab is refused (`BROWSER_SESSION_OWNED`) — not a permission question
  but a correctness one, since two actors in one tab interleave.
- **Reopening a session never hands it back.** A reload that re-reports the same
  tab keeps the owner it had, so take-control cannot be defeated by refreshing.

`takeControl` / `returnControl` are deliberately **not tools**. An agent must not
be able to hand control to itself; taking the wheel is a person's act, reached
from the host or the UI.

## Events

| Event | Meaning |
| --- | --- |
| `browser.session.opened` / `browser.session.closed` | a session exists / is gone |
| `browser.action` / `browser.action.failed` | an agent acted, with session, agent, action and URL |
| `browser.paused` / `browser.resumed` | control moved and the agent stopped / may continue |
| `browser.control.transferred` | the transfer itself: `from`, `to`, `by` |

All seven are forwarded to the renderer.

## The host adapter

Everything that touches a real engine goes through `io.browser.host`. It may be
an object, or a function returning one — the Electron main process only has a
browser handle once a window exists, and late binding means the tools never have
to be re-registered to pick it up.

```js
navigate({ sessionId, url, agentId })                -> { url, title }
read({ sessionId, url, selector, agentId })          -> { url, title, text }
screenshot({ sessionId, fullPage, agentId })         -> { path } | { dataUrl }
click({ sessionId, selector, text, agentId })        -> { url, title }
type({ sessionId, selector, text, submit, agentId }) -> { url, title }
download({ sessionId, url, agentId })                -> { path }
clipboard({ sessionId, action, text, agentId })      -> { action, text }
upload({ sessionId, selector, files, agentId })      -> { files }
authenticate({ sessionId, url, agentId })            -> { url, title, authenticated }
submit({ sessionId, selector, external, agentId })   -> { url, title }
```

With **no host wired** the tools still register — capability discovery stays
stable, and a planner can see the real shape of what exists — but calling one
fails with `BROWSER_UNAVAILABLE`. A tool that silently does nothing would be
worse than one that is honestly not connected. A host that implements only some
methods gets the same treatment per action.

## What is not done yet

Two pieces of wiring remain before take-control is real in the shipped app:

1. **A main-process host adapter.** `io.browser.host` needs an implementation
   over the existing tab surface (`browser-views.js` owns the `views` map and the
   CDP/MCP transport). The contract above is all it has to satisfy.
2. **Holding the MCP route when a person takes control.** Agents currently reach
   the browser through a per-session Playwright MCP endpoint
   (`src/main/browser-mcp.js`). "Take control" must also refuse that path, or it
   will stop the core tools while the MCP route keeps driving the same tab. The
   existing `refresh()`/`Access` revocation is the mechanism to reuse.
3. **A UI affordance** for take/return control. Nothing in the app exposes it
   today.

Until (1) and (2) land, this subsystem is the control plane and the policy
vocabulary; it is not yet the thing the shipped agent actually drives the browser
with.

## Tests

`tests/core-browser.test.mjs` — 18 tests: the ownership gate (take, return, the
refusal, one-agent-per-session, reopening), the catalogue (every §24 action
present, nothing dangerous hiding behind `moderate`), and the platform path (no
engine → `BROWSER_UNAVAILABLE`; a wired host drives the page; a level the agent
lacks denies the call; a destructive action asks for approval and a denial stops
it before anything is sent).
