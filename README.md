# DeepSeek Harness Browser Use

Persistent, interactive browser automation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Status: architecture/RFC. Implementation has not started yet.

## Target experience

- the agent receives browser tools backed by Playwright;
- DSH Web shows the same browser in a resizable pane next to the chat;
- a person can temporarily take control to sign in, solve MFA/CAPTCHA, or inspect the page;
- cookies, local storage, IndexedDB, permissions, and open tabs survive DSH restarts;
- secrets typed by a person are not copied into the model transcript or tool logs.

## Proposed stack

- **Automation:** Playwright + Chromium.
- **Persistence:** one durable Chromium `userDataDir` under `$DSH_HOME`, plus an atomic tab-state manifest.
- **Viewport:** Chromium DevTools Protocol screencast over a plugin-owned WebSocket.
- **DSH integration:** one installable DSH profile bundle and dual-face Cordis package: Host service/tools at the package root, React client plugin at `./client`.
- **Human/agent coordination:** an explicit exclusive control lease. Human takeover prevents agent actions until control is released.

The current DSH layout has a fixed `sidebar | conversation | details` frame. A true side-by-side browser should not shadow the existing single-owner tool-details slot, so the design requires a small generic right-dock extension in `@deepseek-ai/dsh-client-ui-layout`. The physical frame remains three columns and switches the right column between tool details and named dock surfaces. A center-column Browser tab is retained as a compatibility fallback.

## Documents

- [Architecture](docs/architecture.md)
- [Delivery roadmap](docs/roadmap.md)

## Repository

The base branch is `trunk`. This repository is public and licensed under MIT.
