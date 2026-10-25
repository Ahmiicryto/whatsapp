// Must be imported first in every test file: config is read at import time.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@localhost:5433/wa_test?host=/var/tmp/pgdata";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.SHOPIFY_API_KEY = "test-key";
process.env.SHOPIFY_API_SECRET = "shopify-app-secret";
process.env.META_APP_SECRET = "meta-app-secret";
process.env.META_APP_ID = "123456";
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-me";
process.env.SUPER_ADMIN_EMAIL = "root@example.com";
process.env.SUPER_ADMIN_PASSWORD = "rootpassword1";
process.env.DEFAULT_COUNTRY = "PK";
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_MAPS_API_KEY;
process.env.CRON_SECRET = "cron-secret-123";
