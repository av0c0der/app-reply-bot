/**
 * Scheduler - Polls for new reviews periodically
 * Uses node-cron to run polling jobs for all active apps
 * Uses accounts-based model for credential management
 */

import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { supabase, AppWithAccount, Review, User } from './services/supabase';
import { appStoreClient, ParsedAppStoreReview } from './services/appStoreClient';
import { playStoreClient, ParsedPlayStoreReview } from './services/playStoreClient';
import { sendReviewNotificationToChat } from './handlers/reviewHandler';
import { schedulerLogger as logger } from './utils/logger';

type ParsedReview = ParsedAppStoreReview | ParsedPlayStoreReview;

/**
 * Escape special characters for Telegram HTML
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

interface SchedulerConfig {
    pollIntervalMinutes: number;
}

export class ReviewScheduler {
    private bot: Telegraf;
    private config: SchedulerConfig;
    private isRunning: boolean = false;
    private cronJob: cron.ScheduledTask | null = null;
    private isPolling: boolean = false;

    constructor(bot: Telegraf, config?: Partial<SchedulerConfig>) {
        this.bot = bot;
        this.config = {
            pollIntervalMinutes: config?.pollIntervalMinutes ||
                parseInt(process.env.POLL_INTERVAL_MINUTES || '15', 10),
        };
        logger.debug('Scheduler initialized', { config: this.config });
    }

    /**
     * Manually trigger a poll for a specific user's apps
     * Returns the number of new reviews found
     */
    async pollUserApps(userId: string): Promise<{ appName: string; store: string; newReviews: number }[]> {
        logger.debug('pollUserApps called', { userId });
        const results: { appName: string; store: string; newReviews: number }[] = [];

        const user = await supabase.getUserById(userId);
        if (!user) {
            logger.debug('pollUserApps: User not found', { userId });
            return results;
        }

        const apps = await supabase.getAppsByUser(userId);
        logger.debug(`pollUserApps: Found ${apps.length} apps for user`, { userId, appCount: apps.length });

        for (const app of apps) {
            // Get app with account info
            const appWithAccount = await supabase.getAppWithAccount(app.id);
            if (!appWithAccount || !appWithAccount.account?.is_valid) {
                logger.debug(`Skipping app ${app.name} - no valid account`);
                continue;
            }

            const newReviews = await this.pollAppReviews(appWithAccount, user);
            results.push({
                appName: app.name,
                store: app.store,
                newReviews: newReviews.length,
            });
        }

        logger.debug('pollUserApps completed', { userId, results });
        return results;
    }

    /**
     * Start the scheduler
     */
    start(): void {
        if (this.isRunning) {
            logger.debug('Scheduler already running, skipping start');
            return;
        }

        const interval = this.config.pollIntervalMinutes;
        logger.info(`Starting scheduler with ${interval} minute interval`);
        this.isRunning = true;

        // Run immediately on start
        logger.debug('Running initial poll...');
        this.pollAllApps().catch((error) => {
            logger.error('Initial poll error:', error);
        });

        // Schedule periodic runs
        const cronExpression = `*/${interval} * * * *`;
        logger.debug(`Setting up cron job with expression: ${cronExpression}`);
        this.cronJob = cron.schedule(cronExpression, () => {
            logger.debug('Cron job triggered');
            this.pollAllApps().catch((error) => {
                logger.error('Poll error:', error);
            });
        }, {
            scheduled: false,
        });

        this.cronJob.start();
        logger.info('Scheduler started successfully');
    }

    /**
     * Stop the scheduler
     */
    stop(): void {
        logger.debug('Stopping scheduler...');
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
        this.isRunning = false;
        logger.info('Scheduler stopped');
    }

    /**
     * Poll all active apps for new reviews
     */
    private async pollAllApps(): Promise<void> {
        if (this.isPolling) {
            logger.debug('Poll already in progress, skipping');
            return;
        }

        this.isPolling = true;
        logger.info('Starting poll cycle...');
        const startTime = Date.now();

        try {
            const apps = await supabase.getAllActiveAppsWithAccounts();
            logger.debug(`Found ${apps.length} active apps to poll`);

            // Group apps by user for notifications
            const userApps = new Map<string, { user: User; apps: AppWithAccount[] }>();

            for (const app of apps) {
                const user = await supabase.getUserById(app.user_id);
                if (!user || !user.is_active) continue;

                if (!userApps.has(user.id)) {
                    userApps.set(user.id, { user, apps: [] });
                }
                userApps.get(user.id)!.apps.push(app);
            }

            // Poll each user's apps
            for (const [userId, { user, apps: userAppList }] of userApps) {
                const preferences = await supabase.getUserPreferences(userId);
                const notificationsEnabled = preferences?.preferences?.notification_enabled ?? true;
                let totalNewReviews = 0;
                let notificationCount = 0;

                for (const app of userAppList) {
                    try {
                        logger.debug(`Polling app: ${app.name}`, { appId: app.id });
                        const newReviews = await this.pollAppReviews(app, user);
                        totalNewReviews += newReviews.length;

                        if (!notificationsEnabled) {
                            continue;
                        }

                        for (const review of newReviews) {
                            try {
                                await sendReviewNotificationToChat(
                                    this.bot.telegram,
                                    user.telegram_id,
                                    user.id,
                                    review,
                                    app
                                );
                                notificationCount++;
                            } catch (error) {
                                logger.error(`Failed to notify user about review ${review.id}:`, error);
                            }
                        }
                    } catch (error) {
                        logger.error(`Error polling app ${app.name}:`, error);
                    }
                }

                if (totalNewReviews > 0) {
                    logger.info(`Found ${totalNewReviews} new reviews for user ${userId}`, {
                        notificationsEnabled,
                        notificationsSent: notificationCount,
                    });
                }
            }

            const duration = Date.now() - startTime;
            logger.info(`Poll cycle complete in ${duration}ms`);
        } catch (error) {
            logger.error('Failed to fetch apps:', error);
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Poll reviews for a single app
     * Returns the new reviews saved during this poll
     */
    private async pollAppReviews(app: AppWithAccount, user: User): Promise<Review[]> {
        logger.debug(`pollAppReviews called for ${app.name}`, { appId: app.id, store: app.store, lastPollAt: app.last_poll_at });

        const account = app.account;
        if (!account || !account.is_valid) {
            logger.debug(`Skipping app ${app.name} - no valid account`);
            return [];
        }

        // Skip apps that are not published (e.g., drafts or removed from sale)
        if (app.store === 'app_store') {
            const availability = await appStoreClient.isAppReadyForSale(account, app.store_id);
            if (!availability.ready) {
                logger.debug(`Skipping app ${app.name} - not ready for sale`, {
                    appId: app.id,
                    appStoreState: availability.state,
                });
                return [];
            }
        }

        const newReviews: Review[] = [];

        // Parse last poll timestamp if available
        const lastPollAt = app.last_poll_at ? new Date(app.last_poll_at) : undefined;

        try {
            let reviews: ParsedReview[] = [];

            if (app.store === 'app_store') {
                logger.debug(`Fetching App Store reviews for ${app.name}`, { storeId: app.store_id, lastPollAt: lastPollAt?.toISOString() });
                reviews = await appStoreClient.fetchReviewsWithAccount(account, app.store_id, lastPollAt);
            } else if (app.store === 'play_store') {
                logger.debug(`Fetching Play Store reviews for ${app.name}`, { storeId: app.store_id, lastPollAt: lastPollAt?.toISOString() });
                reviews = await playStoreClient.fetchReviewsWithAccount(account, app.store_id, lastPollAt);
            }

            logger.debug(`Found ${reviews.length} new reviews for ${app.name} since ${lastPollAt?.toISOString() || 'beginning'}`);

            for (const review of reviews) {
                const saved = await this.saveReview(review, app, user);
                if (saved) {
                    newReviews.push(saved);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error(`Failed to fetch reviews for ${app.name}: ${errorMessage}`);

            // Check if credentials were invalidated
            if (errorMessage.includes('invalid') || errorMessage.includes('Credentials')) {
                await this.notifyCredentialError(user.telegram_id, app.name, errorMessage);
            }
        }

        // Update last poll time
        logger.debug(`Updating last poll time for ${app.name}`);
        await supabase.updateAppLastPoll(app.id);

        return newReviews;
    }

    /**
     * Save a single review to the database (no AI generation)
     * Returns the saved review when it is new
     */
    private async saveReview(
        review: ParsedReview,
        app: AppWithAccount,
        user: User
    ): Promise<Review | null> {
        logger.debug('saveReview called', { externalId: review.externalId, store: app.store, appName: app.name });

        // Check if we've already processed this review
        const existingReview = await supabase.getReviewByExternalId(app.store, review.externalId);
        if (existingReview) {
            logger.debug('Review already exists, skipping', { externalId: review.externalId });
            return null;
        }

        // Create review record
        const territory = 'territory' in review ? review.territory :
            ('language' in review ? review.language : null);

        // Get app version from Play Store reviews
        const appVersion = 'appVersionName' in review ? review.appVersionName : null;

        const savedReview = await supabase.createReview({
            app_id: app.id,
            user_id: user.id,
            store: app.store,
            external_review_id: review.externalId,
            rating: review.rating,
            title: review.title,
            body: review.body,
            reviewer_name: review.reviewerName,
            review_date: review.reviewDate,
            territory: territory,
            app_version: appVersion,
            status: 'pending',
        });

        if (!savedReview) {
            logger.debug('Review was duplicate, not saved', { externalId: review.externalId });
            return null;
        }

        logger.info(`New ${app.store} review saved: ${savedReview.id} (${review.rating} stars)`, {
            reviewId: savedReview.id,
            rating: review.rating,
            store: app.store,
            appName: app.name,
        });
        return savedReview;
    }

    /**
     * Notify user of credential error
     */
    private async notifyCredentialError(
        telegramId: number,
        appName: string,
        error: string
    ): Promise<void> {
        logger.debug('Sending credential error notification', { telegramId, appName, error });
        try {
            await this.bot.telegram.sendMessage(
                telegramId,
                `⚠️ <b>Credential Error for ${escapeHtml(appName)}</b>\n\n` +
                `${escapeHtml(error)}\n\n` +
                `Please update your account using /account`,
                { parse_mode: 'HTML' }
            );
            logger.debug('Credential error notification sent successfully');
        } catch (error) {
            logger.error(`Failed to send credential error notification:`, error);
        }
    }
}
