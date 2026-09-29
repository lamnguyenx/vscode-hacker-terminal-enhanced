NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)
VSIX    := build/$(EXT_ID).vsix

CDP_PORT ?= 9024

.PHONY: build install install-code install-code-server clean vsix test-e2e

build: vsix

install: install-code install-code-server

install-code: build
	code --install-extension $(VSIX) --force

install-code-server: build
	code-server --install-extension $(VSIX) --force

## Playwright E2E tests (REST Control arranges/acts; CDP browser asserts).
test-e2e:
	CDP_PORT=$(CDP_PORT) npx playwright test --config playwright.config.ts

vsix:
	npm install --no-audit --no-fund
	npm run compile
	mkdir -p build
	npx vsce package -o $(VSIX)

clean:
	rm -rf build out