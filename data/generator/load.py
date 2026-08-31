"""Load generated CSVs into Postgres.

Idempotent: truncates the data tables first, so re-running produces the same state
rather than accumulating duplicates.

Usage:
    python load.py                      # uses DATABASE_URL from environment/.env
    python load.py --sql-only > out.sql # emit SQL instead of connecting
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

GENERATED = Path(__file__).resolve().parents[1] / "generated"

# Children before parents; the loader inserts in reverse.
TRUNCATE_ORDER = [
    "audit_events", "action_outcomes", "scheduled_actions", "recovery_actions",
    "recovery_cases", "checkout_sessions", "payment_attempts", "orders",
    "customer_preferences", "customers", "merchants",
]

TABLES = [
    ("merchants", "merchants.csv",
     ["id", "name", "category", "approval_threshold_paise"],
     {"approval_threshold_paise": int}),
    ("customers", "customers.csv",
     ["id", "merchant_id", "city", "prior_success_count", "prior_failure_count"],
     {"prior_success_count": int, "prior_failure_count": int}),
    ("customer_preferences", "customer_preferences.csv",
     ["customer_id", "is_opted_out", "preferred_method", "opted_out_at"],
     {"is_opted_out": "bool", "opted_out_at": "nullable_ts"}),
    ("orders", "orders.csv",
     ["id", "merchant_id", "customer_id", "amount_paise", "currency", "created_at"],
     {"amount_paise": int}),
    ("payment_attempts", "payment_attempts.csv",
     ["id", "order_id", "customer_id", "merchant_id", "amount_paise", "payment_method",
      "attempt_number", "status", "failure_code", "failure_message", "checkout_stage",
      "attempted_at", "true_diagnosis", "split"],
     {"amount_paise": int, "attempt_number": int,
      "failure_code": "nullable", "failure_message": "nullable",
      "true_diagnosis": "nullable_enum"}),
]


def sql_literal(value: str, coercion) -> str:
    if coercion is int:
        return str(int(value))
    if coercion == "bool":
        return "true" if str(value).strip().lower() in {"true", "1", "yes"} else "false"
    if coercion in {"nullable", "nullable_ts", "nullable_enum"} and value == "":
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def rows_for(csv_path: Path, columns: list[str], coercions: dict) -> list[str]:
    out = []
    with csv_path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            values = [sql_literal(row[c], coercions.get(c)) for c in columns]
            out.append("(" + ",".join(values) + ")")
    return out


def build_statements(batch_size: int = 500) -> list[str]:
    statements = [f"TRUNCATE TABLE {', '.join(TRUNCATE_ORDER)} CASCADE"]
    for table, filename, columns, coercions in TABLES:
        path = GENERATED / filename
        if not path.exists():
            raise SystemExit(f"missing {path} — run generate.py first")
        values = rows_for(path, columns, coercions)
        for i in range(0, len(values), batch_size):
            chunk = ",".join(values[i:i + batch_size])
            statements.append(f"INSERT INTO {table} ({','.join(columns)}) VALUES {chunk}")
    return statements


def main() -> None:
    parser = argparse.ArgumentParser(description="Load Reclaim CSVs into Postgres")
    parser.add_argument("--sql-only", action="store_true", help="print SQL instead of connecting")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()

    statements = build_statements(args.batch_size)

    if args.sql_only:
        for s in statements:
            print(s + ";")
        return

    url = os.environ.get("DATABASE_URL")
    if not url:
        env_file = Path(__file__).resolve().parents[2] / ".env"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("DATABASE_URL="):
                    url = line.split("=", 1)[1].strip()
                    break
    if not url:
        raise SystemExit("DATABASE_URL not set (env or .env). Use --sql-only to emit SQL instead.")

    try:
        import psycopg
    except ImportError:
        raise SystemExit("pip install 'psycopg[binary]', or use --sql-only")

    with psycopg.connect(url) as conn, conn.cursor() as cur:
        for s in statements:
            cur.execute(s)
        conn.commit()
    print(f"loaded {len(statements) - 1} insert batches", file=sys.stderr)


if __name__ == "__main__":
    main()
