# @sqlinqo/example-basic-pg

A runnable tour of the query API.

```bash
pnpm --filter @sqlinqo/example-basic-pg start
```

Without `DATABASE_URL` it prints the SQL each query compiles to, which is the quickest way to see
what the translator does with a given lambda. With `DATABASE_URL` set it also executes them.

```bash
pnpm test:db:up
DATABASE_URL=postgres://sqlinqo:sqlinqo@localhost:5433/sqlinqo pnpm --filter @sqlinqo/example-basic-pg start
```

With a local environment:

```bash
$env:DATABASE_URL = 'postgres://linqts:linqts@localhost:5432/linqts'; pnpm --filter @sqlinqo/example-basic-pg start
```
