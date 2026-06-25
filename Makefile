.PHONY: build build-web test typecheck server client install

PORT ?= 4343
URL  := http://localhost:$(PORT)/

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

install:
	@command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
	bun install

build-web:
	bun run build:web

server: build-web
	@echo "Hub → $(URL)"
	bun run src/cli.ts serve --port $(PORT)

client:
	open $(URL)
