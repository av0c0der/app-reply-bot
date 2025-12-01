-- Reset migration: Drop all {{SCHEMA_NAME}} schema objects
-- Run this before the initial schema migration to reset the database

-- Drop views first (they depend on tables)
DROP VIEW IF EXISTS {{SCHEMA_NAME}}.pending_reviews CASCADE;
DROP VIEW IF EXISTS {{SCHEMA_NAME}}.apps_with_credentials CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.update_updated_at CASCADE;
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.check_max_apps CASCADE;
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.check_daily_review_limit CASCADE;
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.store_credential CASCADE;
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.get_credential CASCADE;
DROP FUNCTION IF EXISTS {{SCHEMA_NAME}}.invalidate_credential CASCADE;

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.telegram_messages CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.responses CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.reviews CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.app_credentials CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.apps CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.user_preferences CASCADE;
DROP TABLE IF EXISTS {{SCHEMA_NAME}}.users CASCADE;
