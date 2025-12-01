/**
 * Supabase Service
 * Handles all database operations with the reviews_bot schema
 * Uses accounts-based model for credential management
 */

import { createClient } from '@supabase/supabase-js';
import { supabaseLogger as logger } from '../utils/logger';

// Types for our database schema
export interface User {
    id: string;
    telegram_id: number;
    telegram_username: string | null;
    first_name: string | null;
    last_name: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface UserPreferencesData {
    auto_approve_positive: boolean;
    notification_enabled: boolean;
    custom_instructions?: string;
}

export interface UserPreferences {
    id: string;
    user_id: string;
    preferences: UserPreferencesData;
    created_at: string;
    updated_at: string;
}

export const DEFAULT_PREFERENCES: UserPreferencesData = {
    auto_approve_positive: false,
    notification_enabled: true,
    custom_instructions: undefined,
};

export interface Account {
    id: string;
    user_id: string;
    account_type: 'app_store_connect' | 'google_play';
    name: string;
    credential_data: string;
    apple_key_id: string | null;
    apple_issuer_id: string | null;
    is_valid: boolean;
    last_validated_at: string | null;
    validation_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface App {
    id: string;
    user_id: string;
    account_id: string;
    name: string;
    bundle_id: string | null;
    store_id: string;
    store: 'app_store' | 'play_store';
    is_active: boolean;
    is_auto_discovered: boolean;
    last_poll_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface AppWithAccount extends App {
    account: Account;
}

export interface Review {
    id: string;
    app_id: string;
    user_id: string;
    store: 'app_store' | 'play_store';
    external_review_id: string;
    rating: number;
    title: string | null;
    body: string;
    reviewer_name: string | null;
    review_date: string | null;
    territory: string | null;
    app_version: string | null;
    status: 'pending' | 'notified' | 'approved' | 'responded' | 'rejected' | 'failed';
    created_at: string;
    updated_at: string;
}

export interface Response {
    id: string;
    review_id: string;
    user_id: string;
    ai_generated_text: string;
    final_text: string | null;
    is_approved: boolean;
    approved_at: string | null;
    posted_at: string | null;
    post_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface TelegramMessage {
    id: string;
    review_id: string;
    user_id: string;
    chat_id: number;
    message_id: number;
    message_type: string;
    created_at: string;
}

export interface AccountCredentialData {
    account_id: string;
    account_type: string;
    name: string;
    credential_data: string;
    apple_key_id: string | null;
    apple_issuer_id: string | null;
    is_valid: boolean;
}

class SupabaseService {
    private client;

    constructor() {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY;

        if (!url || !key) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
        }

        const schemaName = process.env.DATABASE_SCHEMA || 'reviews_bot';
        this.client = createClient(url, key, {
            db: { schema: schemaName },
        });
        logger.debug('Supabase client initialized', { url, schema: schemaName });
    }

    // ============================================================================
    // USER OPERATIONS
    // ============================================================================

    async getOrCreateUser(telegramId: number, userData: Partial<User>): Promise<User> {
        logger.debugDb('getOrCreateUser', 'users', { telegramId });

        // Try to get existing user
        const { data: existingUser } = await this.client
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .single();

        if (existingUser) {
            logger.debug('User found, updating', { userId: existingUser.id });
            // Update user info if changed
            const { data: updatedUser } = await this.client
                .from('users')
                .update({
                    telegram_username: userData.telegram_username,
                    first_name: userData.first_name,
                    last_name: userData.last_name,
                })
                .eq('telegram_id', telegramId)
                .select()
                .single();
            return (updatedUser || existingUser) as User;
        }

        logger.debug('Creating new user', { telegramId });
        // Create new user
        const { data: newUser, error } = await this.client
            .from('users')
            .insert({
                telegram_id: telegramId,
                telegram_username: userData.telegram_username,
                first_name: userData.first_name,
                last_name: userData.last_name,
            })
            .select()
            .single();

        if (error) {
            logger.error('Failed to create user', error);
            throw error;
        }

        logger.debug('User created, adding default preferences', { userId: (newUser as User).id });
        // Create default preferences
        await this.client.from('user_preferences').insert({
            user_id: (newUser as User).id,
        });

        return newUser as User;
    }

    async getUserByTelegramId(telegramId: number): Promise<User | null> {
        logger.debugDb('SELECT', 'users', { telegramId });
        const { data } = await this.client
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .single();
        logger.debug('getUserByTelegramId result', { found: !!data });
        return data as User | null;
    }

    async getUserById(userId: string): Promise<User | null> {
        logger.debugDb('SELECT', 'users', { userId });
        const { data } = await this.client
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();
        logger.debug('getUserById result', { found: !!data });
        return data as User | null;
    }

    async getUserPreferences(userId: string): Promise<UserPreferences | null> {
        const { data } = await this.client
            .from('user_preferences')
            .select('*')
            .eq('user_id', userId)
            .single();
        return data as UserPreferences | null;
    }

    async updateUserPreferences(
        userId: string,
        preferencesUpdate: Partial<UserPreferencesData>
    ): Promise<UserPreferences | null> {
        // First get current preferences
        const current = await this.getUserPreferences(userId);
        const currentPrefs = current?.preferences || DEFAULT_PREFERENCES;

        // Merge with updates
        const mergedPreferences = {
            ...currentPrefs,
            ...preferencesUpdate,
        };

        const { data } = await this.client
            .from('user_preferences')
            .update({ preferences: mergedPreferences })
            .eq('user_id', userId)
            .select()
            .single();
        return data as UserPreferences | null;
    }

    // ============================================================================
    // ACCOUNT OPERATIONS
    // ============================================================================

    async storeAccountCredential(
        userId: string,
        accountType: 'app_store_connect' | 'google_play',
        name: string,
        credentialData: string,
        appleKeyId?: string,
        appleIssuerId?: string
    ): Promise<string> {
        logger.debugDb('storeAccountCredential', 'accounts', { userId, accountType, name });
        const { data, error } = await this.client.rpc('store_account_credential', {
            p_user_id: userId,
            p_account_type: accountType,
            p_name: name,
            p_credential_data: credentialData,
            p_apple_key_id: appleKeyId || null,
            p_apple_issuer_id: appleIssuerId || null,
        });

        if (error) {
            logger.error('Failed to store account credential', error);
            throw error;
        }
        logger.debug('Account credential stored', { accountId: data });
        return data as string;
    }

    async getAccountsByUser(userId: string): Promise<Account[]> {
        logger.debugDb('SELECT', 'accounts', { userId });
        const { data, error } = await this.client
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Failed to get accounts by user', error);
            throw error;
        }
        logger.debug('getAccountsByUser result', { count: data?.length || 0 });
        return (data || []) as Account[];
    }

    async getAccountById(accountId: string): Promise<Account | null> {
        const { data } = await this.client
            .from('accounts')
            .select('*')
            .eq('id', accountId)
            .single();
        return data as Account | null;
    }

    async getAccountByType(
        userId: string,
        accountType: 'app_store_connect' | 'google_play'
    ): Promise<Account | null> {
        logger.debugDb('SELECT', 'accounts', { userId, accountType });
        const { data } = await this.client
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('account_type', accountType)
            .single();
        logger.debug('getAccountByType result', { found: !!data });
        return data as Account | null;
    }

    async getAccountCredential(
        userId: string,
        accountType?: 'app_store_connect' | 'google_play'
    ): Promise<AccountCredentialData | null> {
        const { data, error } = await this.client.rpc('get_account_credential', {
            p_user_id: userId,
            p_account_type: accountType || null,
        });

        if (error) throw error;
        const results = data as AccountCredentialData[] | null;
        return results?.[0] || null;
    }

    async invalidateAccount(accountId: string, errorMessage: string): Promise<void> {
        logger.debug('Invalidating account', { accountId, errorMessage });
        const { error } = await this.client.rpc('invalidate_account', {
            p_account_id: accountId,
            p_error: errorMessage,
        });

        if (error) throw error;
    }

    async deleteAccount(accountId: string): Promise<void> {
        logger.debugDb('DELETE', 'accounts', { accountId });
        const { error } = await this.client
            .from('accounts')
            .delete()
            .eq('id', accountId);

        if (error) {
            logger.error('Failed to delete account', error);
            throw error;
        }
    }

    // ============================================================================
    // APP OPERATIONS
    // ============================================================================

    async createApp(appData: Partial<App>): Promise<App> {
        logger.debugDb('INSERT', 'apps', { name: appData.name, store: appData.store });
        const { data, error } = await this.client
            .from('apps')
            .insert(appData)
            .select()
            .single();

        if (error) {
            logger.error('Failed to create app', error);
            throw error;
        }
        logger.debug('App created', { appId: (data as App).id });
        return data as App;
    }

    async upsertApp(appData: {
        user_id: string;
        account_id: string;
        name: string;
        bundle_id?: string;
        store_id: string;
        store: 'app_store' | 'play_store';
        is_auto_discovered?: boolean;
    }): Promise<App> {
        logger.debugDb('UPSERT', 'apps', { name: appData.name, storeId: appData.store_id });
        const { data, error } = await this.client
            .from('apps')
            .upsert(
                {
                    ...appData,
                    is_auto_discovered: appData.is_auto_discovered ?? true,
                },
                { onConflict: 'account_id,store_id' }
            )
            .select()
            .single();

        if (error) {
            logger.error('Failed to upsert app', error);
            throw error;
        }
        logger.debug('App upserted', { appId: (data as App).id });
        return data as App;
    }

    async getAppsByUser(userId: string): Promise<App[]> {
        logger.debugDb('SELECT', 'apps', { userId });
        const { data, error } = await this.client
            .from('apps')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Failed to get apps by user', error);
            throw error;
        }
        logger.debug('getAppsByUser result', { count: data?.length || 0 });
        return (data || []) as App[];
    }

    async getAppsByAccount(accountId: string): Promise<App[]> {
        logger.debugDb('SELECT', 'apps', { accountId });
        const { data, error } = await this.client
            .from('apps')
            .select('*')
            .eq('account_id', accountId)
            .order('name', { ascending: true });

        if (error) {
            logger.error('Failed to get apps by account', error);
            throw error;
        }
        logger.debug('getAppsByAccount result', { count: data?.length || 0 });
        return (data || []) as App[];
    }

    async getActiveAppsByAccount(accountId: string): Promise<App[]> {
        logger.debugDb('SELECT', 'apps (active)', { accountId });
        const { data, error } = await this.client
            .from('apps')
            .select('*')
            .eq('account_id', accountId)
            .eq('is_active', true)
            .order('name', { ascending: true });

        if (error) {
            logger.error('Failed to get active apps by account', error);
            throw error;
        }
        return (data || []) as App[];
    }

    async getAppById(appId: string): Promise<App | null> {
        const { data } = await this.client
            .from('apps')
            .select('*')
            .eq('id', appId)
            .single();
        return data as App | null;
    }

    async getAppWithAccount(appId: string): Promise<AppWithAccount | null> {
        const { data } = await this.client
            .from('apps')
            .select('*, account:accounts(*)')
            .eq('id', appId)
            .single();
        return data as AppWithAccount | null;
    }

    async toggleAppActive(appId: string, isActive: boolean): Promise<App | null> {
        logger.debugDb('UPDATE', 'apps', { appId, isActive });
        const { data } = await this.client
            .from('apps')
            .update({ is_active: isActive })
            .eq('id', appId)
            .select()
            .single();
        return data as App | null;
    }

    async deleteApp(appId: string): Promise<void> {
        const { error } = await this.client
            .from('apps')
            .delete()
            .eq('id', appId);

        if (error) throw error;
    }

    async updateAppLastPoll(appId: string): Promise<void> {
        await this.client
            .from('apps')
            .update({ last_poll_at: new Date().toISOString() })
            .eq('id', appId);
    }

    async getAllActiveAppsWithAccounts(): Promise<AppWithAccount[]> {
        logger.debugDb('SELECT', 'apps with accounts', { filter: 'is_active=true' });
        const { data, error } = await this.client
            .from('apps')
            .select('*, account:accounts(*)')
            .eq('is_active', true);

        if (error) {
            logger.error('Failed to get all active apps with accounts', error);
            throw error;
        }

        // Filter out apps where account is invalid
        const validApps = (data || []).filter(
            (app: AppWithAccount) => app.account?.is_valid
        );

        logger.debug('getAllActiveAppsWithAccounts result', {
            total: data?.length || 0,
            valid: validApps.length
        });
        return validApps as AppWithAccount[];
    }

    // ============================================================================
    // REVIEW OPERATIONS
    // ============================================================================

    async createReview(reviewData: Partial<Review>): Promise<Review | null> {
        const { data, error } = await this.client
            .from('reviews')
            .insert(reviewData)
            .select()
            .single();

        // Ignore duplicate key errors
        if (error?.code === '23505') {
            return null;
        }
        if (error) throw error;
        return data as Review;
    }

    async getReviewById(reviewId: string): Promise<Review | null> {
        const { data } = await this.client
            .from('reviews')
            .select('*')
            .eq('id', reviewId)
            .single();
        return data as Review | null;
    }

    async getReviewsByApp(appId: string): Promise<Review[]> {
        const { data } = await this.client
            .from('reviews')
            .select('*')
            .eq('app_id', appId);
        return (data as Review[]) || [];
    }

    async getReviewByExternalId(store: string, externalId: string): Promise<Review | null> {
        const { data } = await this.client
            .from('reviews')
            .select('*')
            .eq('store', store)
            .eq('external_review_id', externalId)
            .single();
        return data as Review | null;
    }

    async updateReviewStatus(
        reviewId: string,
        status: Review['status']
    ): Promise<Review | null> {
        const { data } = await this.client
            .from('reviews')
            .update({ status })
            .eq('id', reviewId)
            .select()
            .single();
        return data as Review | null;
    }

    async getPendingReviewsByUser(userId: string, appIds?: string[]): Promise<Review[]> {
        const allReviews: Review[] = [];
        const pageSize = 1000;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            let query = this.client
                .from('reviews')
                .select('*')
                .eq('user_id', userId)
                .in('status', ['pending', 'notified']);

            // Filter by app IDs if provided
            if (appIds && appIds.length > 0) {
                query = query.in('app_id', appIds);
            }

            const { data } = await query
                .order('review_date', { ascending: false, nullsFirst: false })
                .range(offset, offset + pageSize - 1);

            const reviews = (data || []) as Review[];
            allReviews.push(...reviews);

            if (reviews.length < pageSize) {
                hasMore = false;
            } else {
                offset += pageSize;
            }
        }

        return allReviews;
    }

    // ============================================================================
    // RESPONSE OPERATIONS
    // ============================================================================

    async createResponse(responseData: Partial<Response>): Promise<Response> {
        logger.debug('createResponse called', {
            reviewId: responseData.review_id,
            hasAiText: !!responseData.ai_generated_text,
            aiTextLength: responseData.ai_generated_text?.length,
        });
        const { data, error } = await this.client
            .from('responses')
            .insert(responseData)
            .select()
            .single();

        if (error) {
            logger.error('createResponse failed', { error: error.message });
            throw error;
        }
        logger.debug('createResponse success', {
            responseId: data?.id,
            returnedAiText: !!data?.ai_generated_text,
            returnedAiTextLength: data?.ai_generated_text?.length,
        });
        return data as Response;
    }

    async getResponseByReviewId(reviewId: string): Promise<Response | null> {
        logger.debug('getResponseByReviewId called', { reviewId });
        const { data, error } = await this.client
            .from('responses')
            .select('*')
            .eq('review_id', reviewId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            logger.debug('getResponseByReviewId no result or error', { reviewId, error: error.message });
        } else if (data) {
            logger.debug('getResponseByReviewId success', {
                reviewId,
                responseId: data?.id,
                hasAiText: !!data?.ai_generated_text,
                aiTextLength: data?.ai_generated_text?.length,
            });
        } else {
            logger.debug('getResponseByReviewId no response found', { reviewId });
        }
        return data as Response | null;
    }

    async updateResponse(
        responseId: string,
        updates: Partial<Response>
    ): Promise<Response | null> {
        logger.debug('updateResponse called', {
            responseId,
            updateKeys: Object.keys(updates),
            hasAiText: !!updates.ai_generated_text,
            aiTextLength: updates.ai_generated_text?.length,
        });
        const { data, error } = await this.client
            .from('responses')
            .update(updates)
            .eq('id', responseId)
            .select()
            .single();
        if (error) {
            logger.error('updateResponse failed', { responseId, error: error.message });
        } else {
            logger.debug('updateResponse success', {
                responseId,
                returnedAiText: !!data?.ai_generated_text,
                returnedAiTextLength: data?.ai_generated_text?.length,
            });
        }
        return data as Response | null;
    }

    async approveResponse(responseId: string, finalText: string): Promise<Response | null> {
        const { data } = await this.client
            .from('responses')
            .update({
                is_approved: true,
                approved_at: new Date().toISOString(),
                final_text: finalText,
            })
            .eq('id', responseId)
            .select()
            .single();
        return data as Response | null;
    }

    async markResponsePosted(responseId: string): Promise<Response | null> {
        const { data } = await this.client
            .from('responses')
            .update({
                posted_at: new Date().toISOString(),
            })
            .eq('id', responseId)
            .select()
            .single();
        return data as Response | null;
    }

    async markResponseFailed(responseId: string, error: string): Promise<Response | null> {
        const { data } = await this.client
            .from('responses')
            .update({
                post_error: error,
            })
            .eq('id', responseId)
            .select()
            .single();
        return data as Response | null;
    }

    // ============================================================================
    // TELEGRAM MESSAGE OPERATIONS
    // ============================================================================

    async saveTelegramMessage(
        reviewId: string,
        userId: string,
        chatId: number,
        messageId: number,
        messageType: string = 'review_notification'
    ): Promise<TelegramMessage> {
        const { data, error } = await this.client
            .from('telegram_messages')
            .insert({
                review_id: reviewId,
                user_id: userId,
                chat_id: chatId,
                message_id: messageId,
                message_type: messageType,
            })
            .select()
            .single();

        if (error) throw error;
        return data as TelegramMessage;
    }

    async getTelegramMessage(reviewId: string): Promise<TelegramMessage | null> {
        const { data } = await this.client
            .from('telegram_messages')
            .select('*')
            .eq('review_id', reviewId)
            .single();
        return data as TelegramMessage | null;
    }
}

// Export singleton instance
export const supabase = new SupabaseService();
