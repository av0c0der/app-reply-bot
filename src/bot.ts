/**
 * Reviews Responder Telegram Bot
 * Main entry point - sets up bot, middleware, handlers, and scheduler
 */

import { Telegraf, Scenes, session, Context } from 'telegraf';
import 'dotenv/config';

// Utils
import { botLogger as logger } from './utils/logger';

// Services
import { supabase } from './services/supabase';

// Scenes
import { accountScene } from './scenes/accountScene';
import { preferencesScene } from './scenes/preferencesScene';

// Handlers
import {
    handleStart,
    handleHelp,
    handleApps,
    handleAccounts,
    handleDeleteAccount,
    handleConfirmDeleteAccount,
    handleStats,
} from './handlers/commands';

import {
    handleGenerateResponse,
    handleApproveResponse,
    handleEditResponse,
    handleRegenerateResponse,
    handleRejectResponse,
    handleDismiss,
    handleCustomResponse,
    handleReviewCommand,
    handleIteratorGenerate,
    handleIteratorApprove,
    handleIteratorEdit,
    handleIteratorRegenerate,
    handleIteratorReject,
    handleIteratorGoto,
    handleIteratorWrite,
    handleAppFilterToggle,
    handleAppFilterSelectAll,
    handleAppFilterDeselectAll,
    handleAppFilterContinue,
    handleAppFilterCancel,
} from './handlers/reviewHandler';

// Scheduler
import { ReviewScheduler } from './scheduler';

/**
 * Escape special characters for Telegram HTML
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Global scheduler reference for /poll command
let scheduler: ReviewScheduler | null = null;

/**
 * Trigger a poll for a specific user's apps
 * Can be called from scenes after account setup
 */
export async function triggerUserPoll(userId: string): Promise<void> {
    if (scheduler) {
        await scheduler.pollUserApps(userId);
    }
}

// Types
interface BotSession extends Scenes.WizardSession {
    pendingEditReviewId?: string;
}

interface BotContext extends Context {
    session: BotSession;
    scene: Scenes.SceneContextScene<BotContext, Scenes.WizardSessionData>;
    wizard: Scenes.WizardContextWizard<BotContext>;
}

// Validate environment variables
function validateEnv(): void {
    logger.debug('Validating environment variables...');
    const required = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENROUTER_API_KEY'];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        logger.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    logger.debug('Environment variables validated successfully');
    logger.debug(`Debug mode: ${logger.isDebugEnabled()}`);
}

// Create bot instance
function createBot(): Telegraf<BotContext> {
    logger.debug('Creating bot instance...');
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    const bot = new Telegraf<BotContext>(token);

    // Create stage with all scenes
    logger.debug('Registering scenes: account-wizard, preferences-wizard');
    const stage = new Scenes.Stage<BotContext>([
        accountScene as unknown as Scenes.WizardScene<BotContext>,
        preferencesScene as unknown as Scenes.WizardScene<BotContext>,
    ]);

    // Middleware
    logger.debug('Setting up middleware: session, stage');
    bot.use(session());
    bot.use(stage.middleware());

    // Debug middleware to log all updates
    bot.use(async (ctx, next) => {
        logger.debug(`Received update: ${ctx.updateType}`, {
            from: ctx.from?.id,
            chat: ctx.chat?.id,
            updateId: ctx.update.update_id,
        });
        return next();
    });

    // Error handling
    bot.catch((error, ctx) => {
        logger.error(`Error for ${ctx.updateType}:`, error);
        ctx.reply('An error occurred. Please try again.').catch(() => { });
    });

    logger.debug('Bot instance created successfully');
    return bot;
}

// Register command handlers
function registerCommands(bot: Telegraf<BotContext>): void {
    logger.debug('Registering command handlers...');

    // Basic commands
    bot.command('start', (ctx) => {
        logger.debug('/start command received', { userId: ctx.from?.id });
        return handleStart(ctx);
    });
    bot.command('help', (ctx) => {
        logger.debug('/help command received', { userId: ctx.from?.id });
        return handleHelp(ctx);
    });
    bot.command('apps', (ctx) => {
        logger.debug('/apps command received', { userId: ctx.from?.id });
        return handleApps(ctx);
    });
    bot.command('review', (ctx) => {
        logger.debug('/review command received', { userId: ctx.from?.id });
        return handleReviewCommand(ctx);
    });
    bot.command('stats', (ctx) => {
        logger.debug('/stats command received', { userId: ctx.from?.id });
        return handleStats(ctx);
    });

    // Poll command - manually trigger review fetch
    bot.command('poll', async (ctx) => {
        logger.debug('/poll command received', { userId: ctx.from?.id });
        const from = ctx.from;
        if (!from) {
            logger.warn('/poll: Unable to identify user');
            await ctx.reply('Unable to identify user.');
            return;
        }

        const user = await supabase.getUserByTelegramId(from.id);
        if (!user) {
            logger.debug('/poll: User not registered', { telegramId: from.id });
            await ctx.reply('Please use /start first to register.');
            return;
        }

        if (!scheduler) {
            logger.error('/poll: Scheduler not initialized');
            await ctx.reply('❌ Scheduler not initialized. Please try again later.');
            return;
        }

        logger.debug('/poll: Starting manual poll for user', { userId: user.id });
        await ctx.reply('🔄 <b>Fetching new reviews...</b>', { parse_mode: 'HTML' });

        try {
            const results = await scheduler.pollUserApps(user.id);
            logger.debug('/poll: Poll completed', { results });

            if (results.length === 0) {
                await ctx.reply('📭 No accounts configured. Use /account to connect an account first.');
                return;
            }

            let message = '✅ <b>Poll Complete</b>\n\n';
            let totalNew = 0;

            for (const result of results) {
                const emoji = result.newReviews > 0 ? '🆕' : '📭';
                message += `${emoji} <b>${escapeHtml(result.appName)}</b>: ${result.newReviews} new review(s)\n`;
                totalNew += result.newReviews;
            }

            if (totalNew === 0) {
                message += '\n<i>No new reviews found.</i>';
            } else {
                message += `\n<i>Total: ${totalNew} new review(s)</i>`;
            }

            await ctx.reply(message, { parse_mode: 'HTML' });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('/poll error:', error);
            await ctx.reply(`❌ Failed to fetch reviews: ${errorMessage}`);
        }
    });

    // Scene entry commands
    bot.command('account', async (ctx) => {
        logger.debug('/account command received', { userId: ctx.from?.id });
        try {
            await ctx.scene.enter('account-wizard');
            logger.debug('/account: Scene entered successfully');
        } catch (error) {
            logger.error('/account error:', error);
            await ctx.reply('Error starting account wizard. Please try again.');
        }
    });
    bot.command('accounts', async (ctx) => {
        logger.debug('/accounts command received', { userId: ctx.from?.id });
        return handleAccounts(ctx);
    });
    bot.command('preferences', async (ctx) => {
        logger.debug('/preferences command received', { userId: ctx.from?.id });
        try {
            await ctx.scene.enter('preferences-wizard');
            logger.debug('/preferences: Scene entered successfully');
        } catch (error) {
            logger.error('/preferences error:', error);
            await ctx.reply('Error starting preferences wizard. Please try again.');
        }
    });

    // Cancel command (works globally)
    bot.command('cancel', async (ctx) => {
        logger.debug('/cancel command received', { userId: ctx.from?.id });
        await ctx.scene.leave();
        await ctx.reply('Operation cancelled.');
    });

    logger.debug('Command handlers registered');
}

// Register callback query handlers
function registerCallbacks(bot: Telegraf<BotContext>): void {
    logger.debug('Registering callback handlers...');

    // Account management
    bot.action(/^delete_account_(.+)$/, async (ctx) => {
        const accountId = ctx.match[1];
        logger.debug('delete_account callback', { accountId });
        await handleDeleteAccount(ctx, accountId);
    });

    bot.action(/^confirm_delete_account_(.+)$/, async (ctx) => {
        const accountId = ctx.match[1];
        await handleConfirmDeleteAccount(ctx, accountId);
    });

    bot.action('cancel_delete', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText('❌ Deletion cancelled.');
    });

    // Review actions
    bot.action(/^generate_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleGenerateResponse(ctx, reviewId);
    });

    bot.action(/^approve_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleApproveResponse(ctx, reviewId);
    });

    bot.action(/^edit_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        // Store the review ID in session for reply handling
        ctx.session.pendingEditReviewId = reviewId;
        await handleEditResponse(ctx, reviewId);
    });

    bot.action(/^regenerate_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleRegenerateResponse(ctx, reviewId);
    });

    bot.action(/^reject_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleRejectResponse(ctx, reviewId);
    });

    bot.action(/^dismiss_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleDismiss(ctx, reviewId);
    });

    // Iterator mode actions
    bot.action(/^iter_generate_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleIteratorGenerate(ctx, reviewId);
    });

    bot.action(/^iter_approve_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleIteratorApprove(ctx, reviewId);
    });

    bot.action(/^iter_edit_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        ctx.session.pendingEditReviewId = reviewId;
        await handleIteratorEdit(ctx, reviewId);
    });

    bot.action(/^iter_regenerate_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleIteratorRegenerate(ctx, reviewId);
    });

    bot.action(/^iter_reject_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        await handleIteratorReject(ctx, reviewId);
    });

    bot.action(/^iter_goto_(\d+)$/, async (ctx) => {
        const index = parseInt(ctx.match[1], 10);
        await handleIteratorGoto(ctx, index);
    });

    // No-op handler for current page button
    bot.action('iter_noop', async (ctx) => {
        await ctx.answerCbQuery();
    });

    bot.action(/^iter_write_(.+)$/, async (ctx) => {
        const reviewId = ctx.match[1];
        ctx.session.pendingEditReviewId = reviewId;
        await handleIteratorWrite(ctx, reviewId);
    });

    // App filter actions for /review command
    bot.action(/^filter_app_(.+)$/, async (ctx) => {
        const appId = ctx.match[1];
        await handleAppFilterToggle(ctx, appId);
    });

    bot.action('filter_select_all', async (ctx) => {
        await handleAppFilterSelectAll(ctx);
    });

    bot.action('filter_deselect_all', async (ctx) => {
        await handleAppFilterDeselectAll(ctx);
    });

    bot.action('filter_continue', async (ctx) => {
        await handleAppFilterContinue(ctx);
    });

    bot.action('filter_cancel', async (ctx) => {
        await handleAppFilterCancel(ctx);
    });
}

// Register message handlers
function registerMessageHandlers(bot: Telegraf<BotContext>): void {
    // Handle replies for custom responses (both edit and write)
    bot.on('message', async (ctx, next) => {
        // Check if this is a reply to edit/write request
        if (
            ctx.message &&
            'reply_to_message' in ctx.message &&
            ctx.message.reply_to_message &&
            'text' in ctx.message &&
            ctx.session.pendingEditReviewId
        ) {
            const replyText = ctx.message.reply_to_message;
            if ('text' in replyText &&
                (replyText.text?.includes('Edit Response') || replyText.text?.includes('Write Your Response'))
            ) {
                const reviewId = ctx.session.pendingEditReviewId;
                const customText = ctx.message.text;

                // Clear pending edit
                delete ctx.session.pendingEditReviewId;

                await handleCustomResponse(ctx, reviewId, customText);
                return;
            }
        }

        return next();
    });

    // Fallback handler for unrecognized messages
    bot.on('message', async (ctx) => {
        // Skip if in a scene (wizard handles its own messages)
        if (ctx.scene.current) {
            return;
        }

        logger.debug('Unrecognized message received', { userId: ctx.from?.id });
        await ctx.reply(
            "🤔 I didn't understand that.\n\n" +
            'Use /help to see available commands.',
            { parse_mode: 'HTML' }
        );
    });
}

// Main function
async function main(): Promise<void> {
    logger.info('🚀 Starting Reviews Responder Bot...');
    logger.debug('Debug mode is enabled - verbose logging active');

    // Validate environment
    validateEnv();

    // Create bot
    const bot = createBot();

    // Register handlers
    registerCommands(bot);
    registerCallbacks(bot);
    registerMessageHandlers(bot);

    // Set bot commands menu
    try {
        logger.debug('Setting bot commands menu...');
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Start the bot' },
            { command: 'account', description: 'Connect a developer account' },
            { command: 'accounts', description: 'View connected accounts' },
            { command: 'apps', description: 'View your apps' },
            { command: 'preferences', description: 'Configure settings' },
            { command: 'review', description: 'Review one by one' },
            { command: 'poll', description: 'Fetch new reviews now' },
            { command: 'stats', description: 'View statistics' },
            { command: 'help', description: 'Show help' },
            { command: 'cancel', description: 'Cancel current operation' },
        ]);
        logger.debug('Bot commands menu set successfully');
    } catch (error) {
        logger.error('Failed to set bot commands:', error);
        throw error;
    }

    // Create and start scheduler
    logger.debug('Creating scheduler instance...');
    scheduler = new ReviewScheduler(bot as unknown as Telegraf);

    // Start bot
    logger.info('🤖 Bot is starting...');

    // Handle shutdown gracefully
    const shutdown = async (signal: string) => {
        logger.info(`${signal} received. Shutting down...`);
        if (scheduler) {
            scheduler.stop();
        }
        bot.stop(signal);
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Launch bot
    await bot.launch();
    logger.info('✅ Bot is running!');

    // Start scheduler
    scheduler.start();
    logger.info('📊 Scheduler is running!');
}

// Run
main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
