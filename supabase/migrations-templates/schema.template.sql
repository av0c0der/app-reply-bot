-- Supabase Migration: Schema for Reviews Bot (Accounts Model)
-- This migration creates the {{SCHEMA_NAME}} schema with all necessary tables,
-- functions, and RLS policies for the Telegram review responder bot.

-- ============================================================================
-- SCHEMA CREATION
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS {{SCHEMA_NAME}};

-- Grant usage on schema to service_role and authenticated
GRANT USAGE ON SCHEMA {{SCHEMA_NAME}} TO service_role;
GRANT USAGE ON SCHEMA {{SCHEMA_NAME}} TO authenticated;
GRANT USAGE ON SCHEMA {{SCHEMA_NAME}} TO anon;

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users table: Telegram users who use the bot
CREATE TABLE {{SCHEMA_NAME}}.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    telegram_username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User preferences table
CREATE TABLE {{SCHEMA_NAME}}.user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE UNIQUE,
    preferences JSONB NOT NULL DEFAULT '{"auto_approve_positive": false, "notification_enabled": true}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Accounts table: Developer accounts (App Store Connect / Google Play)
CREATE TABLE {{SCHEMA_NAME}}.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE,
    account_type TEXT NOT NULL CHECK (account_type IN ('app_store_connect', 'google_play')),
    name TEXT NOT NULL, -- User-friendly name for the account
    credential_data TEXT NOT NULL, -- The .p8 key or service account JSON
    -- Apple-specific metadata (not sensitive)
    apple_key_id TEXT,
    apple_issuer_id TEXT,
    -- Validation status
    is_valid BOOLEAN DEFAULT true,
    last_validated_at TIMESTAMPTZ,
    validation_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Apps table: Apps being monitored (linked to accounts)
CREATE TABLE {{SCHEMA_NAME}}.apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE,
    account_id UUID REFERENCES {{SCHEMA_NAME}}.accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bundle_id TEXT, -- iOS bundle ID or Android package name
    store_id TEXT NOT NULL, -- Apple App ID or Play Store package name
    store TEXT NOT NULL CHECK (store IN ('app_store', 'play_store')),
    is_active BOOLEAN DEFAULT true, -- Whether to monitor this app
    is_auto_discovered BOOLEAN DEFAULT false, -- True if discovered via API
    last_poll_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate apps
    UNIQUE(account_id, store_id)
);

-- Reviews table: Fetched reviews from stores
CREATE TABLE {{SCHEMA_NAME}}.reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES {{SCHEMA_NAME}}.apps(id) ON DELETE CASCADE,
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE,
    store TEXT NOT NULL CHECK (store IN ('app_store', 'play_store')),
    external_review_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title TEXT,
    body TEXT NOT NULL,
    reviewer_name TEXT,
    review_date TIMESTAMPTZ,
    territory TEXT, -- Country/region
    app_version TEXT, -- App version the review was written for
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'approved', 'responded', 'rejected', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate reviews
    UNIQUE(store, external_review_id)
);

-- Responses table: AI-generated and final responses
CREATE TABLE {{SCHEMA_NAME}}.responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES {{SCHEMA_NAME}}.reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE,
    ai_generated_text TEXT NOT NULL,
    final_text TEXT, -- The text that was actually posted (may be edited)
    is_approved BOOLEAN DEFAULT false,
    approved_at TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,
    post_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Telegram messages table: Track sent messages for editing
CREATE TABLE {{SCHEMA_NAME}}.telegram_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES {{SCHEMA_NAME}}.reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    message_type TEXT DEFAULT 'review_notification',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX idx_users_telegram_id ON {{SCHEMA_NAME}}.users(telegram_id);
CREATE INDEX idx_accounts_user_id ON {{SCHEMA_NAME}}.accounts(user_id);
CREATE INDEX idx_accounts_user_type ON {{SCHEMA_NAME}}.accounts(user_id, account_type);
CREATE INDEX idx_apps_user_id ON {{SCHEMA_NAME}}.apps(user_id);
CREATE INDEX idx_apps_account_id ON {{SCHEMA_NAME}}.apps(account_id);
CREATE INDEX idx_apps_user_active ON {{SCHEMA_NAME}}.apps(user_id, is_active);
CREATE INDEX idx_reviews_app_id ON {{SCHEMA_NAME}}.reviews(app_id);
CREATE INDEX idx_reviews_status ON {{SCHEMA_NAME}}.reviews(status);
CREATE INDEX idx_reviews_user_created ON {{SCHEMA_NAME}}.reviews(user_id, created_at DESC);
CREATE INDEX idx_responses_review_id ON {{SCHEMA_NAME}}.responses(review_id);
CREATE INDEX idx_telegram_messages_review ON {{SCHEMA_NAME}}.telegram_messages(review_id);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to check daily review limit (100 per user per day)
CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.check_daily_review_limit(p_user_id UUID)
RETURNS TABLE (
    within_limit BOOLEAN,
    current_count INTEGER,
    max_limit INTEGER
) AS $$
DECLARE
    v_count INTEGER;
    v_max INTEGER := 100;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM {{SCHEMA_NAME}}.reviews
    WHERE user_id = p_user_id
    AND created_at >= CURRENT_DATE
    AND created_at < CURRENT_DATE + INTERVAL '1 day';
    
    RETURN QUERY SELECT 
        v_count < v_max AS within_limit,
        v_count AS current_count,
        v_max AS max_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to store/update account credentials
CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.store_account_credential(
    p_user_id UUID,
    p_account_type TEXT,
    p_name TEXT,
    p_credential_data TEXT,
    p_apple_key_id TEXT DEFAULT NULL,
    p_apple_issuer_id TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_account_id UUID;
BEGIN
    INSERT INTO {{SCHEMA_NAME}}.accounts (
        user_id,
        account_type,
        name,
        credential_data,
        apple_key_id,
        apple_issuer_id,
        is_valid,
        last_validated_at
    )
    VALUES (
        p_user_id,
        p_account_type,
        p_name,
        p_credential_data,
        p_apple_key_id,
        p_apple_issuer_id,
        true,
        NOW()
    )
    RETURNING id INTO v_account_id;
    
    RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get account credential
CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.get_account_credential(
    p_user_id UUID,
    p_account_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    account_id UUID,
    account_type TEXT,
    name TEXT,
    credential_data TEXT,
    apple_key_id TEXT,
    apple_issuer_id TEXT,
    is_valid BOOLEAN
) AS $$
BEGIN
    IF p_account_type IS NULL THEN
        RETURN QUERY
        SELECT 
            a.id AS account_id,
            a.account_type,
            a.name,
            a.credential_data,
            a.apple_key_id,
            a.apple_issuer_id,
            a.is_valid
        FROM {{SCHEMA_NAME}}.accounts a
        WHERE a.user_id = p_user_id;
    ELSE
        RETURN QUERY
        SELECT 
            a.id AS account_id,
            a.account_type,
            a.name,
            a.credential_data,
            a.apple_key_id,
            a.apple_issuer_id,
            a.is_valid
        FROM {{SCHEMA_NAME}}.accounts a
        WHERE a.user_id = p_user_id AND a.account_type = p_account_type;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark account as invalid
CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.invalidate_account(
    p_account_id UUID,
    p_error TEXT
)
RETURNS VOID AS $$
BEGIN
    UPDATE {{SCHEMA_NAME}}.accounts
    SET 
        is_valid = false,
        validation_error = p_error,
        updated_at = NOW()
    WHERE id = p_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update timestamps automatically
CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update_updated_at trigger to all tables
CREATE TRIGGER trigger_update_users_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.users
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

CREATE TRIGGER trigger_update_user_preferences_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.user_preferences
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

CREATE TRIGGER trigger_update_accounts_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.accounts
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

CREATE TRIGGER trigger_update_apps_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.apps
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

CREATE TRIGGER trigger_update_reviews_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.reviews
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

CREATE TRIGGER trigger_update_responses_updated_at
    BEFORE UPDATE ON {{SCHEMA_NAME}}.responses
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE {{SCHEMA_NAME}}.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.telegram_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_users ON {{SCHEMA_NAME}}.users
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_user_preferences ON {{SCHEMA_NAME}}.user_preferences
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_accounts ON {{SCHEMA_NAME}}.accounts
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_apps ON {{SCHEMA_NAME}}.apps
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_reviews ON {{SCHEMA_NAME}}.reviews
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_responses ON {{SCHEMA_NAME}}.responses
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_telegram_messages ON {{SCHEMA_NAME}}.telegram_messages
    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW {{SCHEMA_NAME}}.apps_with_accounts AS
SELECT 
    app.*,
    acc.account_type,
    acc.name AS account_name,
    acc.is_valid AS account_valid,
    acc.validation_error AS account_error,
    acc.credential_data,
    acc.apple_key_id,
    acc.apple_issuer_id
FROM {{SCHEMA_NAME}}.apps app
JOIN {{SCHEMA_NAME}}.accounts acc ON acc.id = app.account_id;

CREATE OR REPLACE VIEW {{SCHEMA_NAME}}.pending_reviews AS
SELECT 
    r.*,
    a.name AS app_name,
    resp.ai_generated_text,
    resp.id AS response_id
FROM {{SCHEMA_NAME}}.reviews r
JOIN {{SCHEMA_NAME}}.apps a ON a.id = r.app_id
LEFT JOIN {{SCHEMA_NAME}}.responses resp ON resp.review_id = r.id
WHERE r.status IN ('pending', 'notified');

-- ============================================================================
-- GRANT PERMISSIONS
-- ============================================================================

GRANT ALL ON ALL TABLES IN SCHEMA {{SCHEMA_NAME}} TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA {{SCHEMA_NAME}} TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {{SCHEMA_NAME}} TO service_role;
