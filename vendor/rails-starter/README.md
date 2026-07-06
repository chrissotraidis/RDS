# Rails Starter

Neutral Rails 8 starter used by RDS for green-field Rails builds.

## Setup

```bash
bundle install
bin/template-setup --app-name=my_app --yes
cp .env.example .env
bin/rails db:prepare
bin/rails server -b 0.0.0.0 -p "${HOST_PORT:-3000}"
```

## Runtime Notes

- PostgreSQL is the default database.
- `/up` is the health endpoint.
- `APP_PUBLIC_HOST` and `APP_EXTRA_HOSTS` are supported for Zo-hosted previews.
- This starter intentionally contains no business or company branding.
