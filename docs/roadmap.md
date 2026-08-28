# План реализации

## Этап 0 — согласование DSH seam

- [ ] Подтвердить plugin package id и npm scope.
- [ ] Предложить в DSH generic `shell.dock` slot и `ctx.layout.openDock/closeDock/toggleDock`.
- [ ] Предложить reusable browser-request trust guard для plugin HTTP/upgrade routes.
- [ ] Зафиксировать поддержку только loopback Web до появления authentication.

**Готово, когда:** отдельный client plugin может открыть справа root-scoped dock, не заменяя conversation details.

## Этап 1 — persistent browser core

- [ ] TypeScript package и Cordis Host service.
- [ ] Playwright startup preflight.
- [ ] `launchPersistentContext` с `$DSH_HOME/browser-use/profiles/default/user-data`.
- [ ] tab registry, active page, popup/close/crash handling.
- [ ] atomic `tabs.json`, restoration, graceful dispose.
- [ ] unit tests manager/store/lifecycle.

**Готово, когда:** login и вкладки переживают остановку и повторный запуск DSH.

## Этап 2 — agent tools

- [ ] `browser_status`, `browser_tabs`, `browser_navigate`.
- [ ] accessibility snapshot и ephemeral refs.
- [ ] click/type/key/scroll/wait.
- [ ] screenshot result и DSH presentation.
- [ ] cancellation, timeout, stale-ref tests.
- [ ] password-field redaction and denial.

**Готово, когда:** агент выполняет типовой login-independent web task только через registered DSH tools.

## Этап 3 — BrowserPanel

- [ ] client bundle manifest и slot registration.
- [ ] tab strip, URL bar, back/forward/reload.
- [ ] CDP screencast gateway и canvas renderer.
- [ ] pointer, wheel, keyboard, resize protocol.
- [ ] backpressure/latest-frame policy.
- [ ] compatibility `conversation.view` fallback.

**Готово, когда:** действия в UI видны агенту, а действия агента видны в UI на той же странице.

## Этап 4 — human takeover

- [ ] exclusive lease, heartbeat и disconnect cleanup.
- [ ] clear Agent/You control status.
- [ ] abort/drain transition.
- [ ] password-safe human typing path.
- [ ] OAuth popup, MFA and CAPTCHA manual scenarios.

**Готово, когда:** пользователь может безопасно войти в аккаунт и вернуть управление агенту без утечки пароля в session log.

## Этап 5 — hardening

- [ ] same-origin/Host/Fetch-Metadata checks и WS nonce.
- [ ] filesystem policy для upload/download.
- [ ] origin allow/deny и approval integration.
- [ ] profile permissions and secret-scanning tests.
- [ ] Chromium crash recovery.
- [ ] E2E restart, popup, download, reconnect, narrow viewport.
- [ ] install/uninstall documentation for `dsh plugin --profile web`.

**Готово, когда:** пакет можно безопасно включить в обычный loopback DSH Web profile.

## Не включать в первый MVP

- remote bind (`0.0.0.0`);
- shared multi-user server;
- arbitrary `browser_evaluate`;
- Firefox/WebKit;
- отдельный background daemon;
- video/HAR recording;
- синхронизацию browser profile через Git или DSH session log.
