#!/bin/bash
# =============================================================================
# Creates the additional databases PayRecon needs, alongside POSTGRES_DB.
#
#   payrecon_test  integration suite (TRUNCATED between test files)
#   payrecon_e2e   Playwright suite (see playwright.config.ts)
#
# Run by the postgres image's entrypoint on FIRST initialisation only — that is,
# when the data volume is empty. Re-running `docker compose up` does not
# re-execute it, so the `IF NOT EXISTS` guard below exists for the case where
# someone runs this script by hand.
# =============================================================================
set -euo pipefail

create_database() {
  local name="$1"
  echo "  ensuring database ${name}"
  psql --username "${POSTGRES_USER}" --dbname postgres --no-password \
       --tuples-only --quiet \
       --command "SELECT 'CREATE DATABASE ${name}' \
                  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')\gexec"
}

echo "PayRecon: creating auxiliary databases"
create_database "payrecon_test"
create_database "payrecon_e2e"
echo "PayRecon: done"
