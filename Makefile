NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)
VSIX    := build/$(EXT_ID).vsix

CDP_PORT ?= 9024

## Meta repo's docker-compose code-server (service `code-server`, project
## `vscode-hacker-meta`). The repo is mounted at the same path inside the
## container, so an absolute host path resolves there too.
CODE_SERVER_CONTAINER  ?= vscode-hacker-meta-code-server-1
CODE_SERVER_USER_DATA  ?= /home/lamnt45/.local/share/code-server
CODE_SERVER_EXTENSIONS ?= $(CODE_SERVER_USER_DATA)/extensions

.PHONY: build install install-code install-code-server install-code-server-dev clean vsix test-units typecheck-webview typecheck-tests test-e2e dev-webview dev-webview-docker

build: vsix

install: install-code install-code-server

install-code: build
	code --install-extension $(VSIX) --force

install-code-server: build
	code-server --install-extension $(VSIX) --force

## Build + install into the code-server running under docker-compose.
## RELOAD THE BROWSER TAB afterwards so a fresh extension host picks up `out/`.
install-code-server-dev: build
	docker exec -u "$$(id -u):$$(id -g)" $(CODE_SERVER_CONTAINER) code-server \
		--install-extension "$(CURDIR)/$(VSIX)" \
		--force \
		--user-data-dir $(CODE_SERVER_USER_DATA) \
		--extensions-dir $(CODE_SERVER_EXTENSIONS)

## Pure-logic checks (bun; no host, no compile).
test-units:
	bun tests/units/history_check.ts
	bun tests/units/store_check.ts
	bun tests/units/emulator_check.ts

## Strict typecheck of the webview bundle + the committed test suite.
typecheck-webview:
	npx tsc -p tsconfig.webview.json

typecheck-tests:
	npx tsc -p tsconfig.tests.json

## Playwright E2E tests (REST Control arranges/acts; CDP browser asserts).
test-e2e:
	CDP_PORT=$(CDP_PORT) npx playwright test --config playwright.config.ts

## Serve the history panel in a browser (read-only mirror of the real DB).
dev-webview:
	bun scripts/dev-webview.ts

## Same, in the pinned Bun container. The service lives in the meta repo's
## docker-compose.yml (next to code-server); run from there, or via this target.
dev-webview-docker:
	docker compose -f ../../docker-compose.yml up lamnguyenx.hacker-terminal-enhanced-webview-dev

vsix:
	npm install --no-audit --no-fund
	npm run compile
	mkdir -p build
	npx vsce package -o $(VSIX)

clean:
	rm -rf build out