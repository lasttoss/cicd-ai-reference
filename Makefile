# Contract every repo in this workflow implements. CI never knows what the project is,
# it only calls these targets.
IMAGE        ?= cicd-ai-reference
TAG          ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
IMAGE_REF    ?= $(IMAGE):$(TAG)
APP_PORT     ?= 8080
PROD_PORT    ?= 9090
DB_PASSWORD  ?= local-dev-only
SMOKE_FULL   ?= 0
SMOKE_URL    ?= http://127.0.0.1:$(PROD_PORT)

.PHONY: ci up down logs migrate seed e2e qa-report build deploy smoke rollback clean measure measure-cold

ci:
	@node --check app/server.mjs
	@node --check scripts/migrate.mjs
	@node --check scripts/seed.mjs
	@node --check scripts/smoke.mjs
	@node --check scripts/qa-report.mjs
	@node -e "JSON.parse(require('fs').readFileSync('package.json'))"
	@echo "ci: ok"

up:
	docker compose up -d --build --wait
	@echo "up: http://127.0.0.1:$(APP_PORT)"

down:
	docker compose down -v

logs:
	docker compose logs --tail=50 app

migrate:
	docker compose run --rm migrate

seed:
	docker compose run --rm seed

e2e:
	APP_URL=http://127.0.0.1:$(APP_PORT) npx playwright test

qa-report:
	node scripts/qa-report.mjs $(ARGS)

build:
	docker build -t $(IMAGE_REF) .

# In CI this is ghcr.io/<org>/<repo>@sha256:... — an immutable reference.
# Locally it is <image>:<git-sha>, which is also never reused for different code.
deploy:
	@test -n "$(IMAGE_DIGEST)" || { echo "IMAGE_DIGEST is required (immutable image reference)"; exit 1; }
	@mkdir -p deploy
	@if [ -f deploy/current-image.txt ]; then cp deploy/current-image.txt deploy/previous-image.txt; fi
	IMAGE_DIGEST=$(IMAGE_DIGEST) DB_PASSWORD=$(DB_PASSWORD) PROD_PORT=$(PROD_PORT) \
		docker compose -f docker-compose.prod.yml up -d --wait
	@echo "$(IMAGE_DIGEST)" > deploy/current-image.txt
	@$(MAKE) --no-print-directory smoke SMOKE_URL=$(SMOKE_URL)
	@echo "deploy: $(IMAGE_DIGEST) live on $(SMOKE_URL)"

smoke:
	SMOKE_URL=$(SMOKE_URL) SMOKE_FULL=$(SMOKE_FULL) node scripts/smoke.mjs

rollback:
	@test -f deploy/previous-image.txt || { echo "no previous image recorded"; exit 1; }
	IMAGE_DIGEST=$$(cat deploy/previous-image.txt) DB_PASSWORD=$(DB_PASSWORD) PROD_PORT=$(PROD_PORT) \
		docker compose -f docker-compose.prod.yml up -d --wait
	@cp deploy/previous-image.txt deploy/current-image.txt
	@$(MAKE) --no-print-directory smoke SMOKE_URL=$(SMOKE_URL)
	@echo "rollback: back on $$(cat deploy/current-image.txt)"

clean:
	rm -rf artifacts reports/*.md reports/*.json test-results node_modules/.cache

seed-demo:
	IMAGE_DIGEST=$$(cat deploy/current-image.txt) DB_PASSWORD=$(DB_PASSWORD) PROD_PORT=$(PROD_PORT) \
		docker compose -f docker-compose.prod.yml --profile demo run --rm seed-demo

measure:
	RUNS=$(RUNS) bash scripts/measure.sh

measure-cold:
	bash scripts/measure-cold.sh
