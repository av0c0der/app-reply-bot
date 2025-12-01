/**
 * Command Handlers for Telegram Bot
 * Basic commands like /start, /help, /account, /apps, etc.
 */

import { Context, Markup } from 'telegraf';
import { supabase } from '../services/supabase';
import { commandsLogger as logger } from '../utils/logger';

/**
 * Escape special characters for Telegram HTML
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Handle /start command - Register user and show welcome message
 */
export async function handleStart(ctx: Context): Promise<void> {
    logger.debug('handleStart called');
    const from = ctx.from;
    if (!from) {
        logger.warn('Unable to identify user');
        await ctx.reply('Unable to identify user.');
        return;
    }

    logger.debug('Registering user', { telegramId: from.id, username: from.username });
    // Register or update user
    await supabase.getOrCreateUser(from.id, {
        telegram_username: from.username || null,
        first_name: from.first_name || null,
        last_name: from.last_name || null,
    });

    logger.debug('User registered successfully', { telegramId: from.id });
    const name = from.first_name || from.username || 'there';

    await ctx.reply(
        `👋 <b>Welcome, ${escapeHtml(name)}!</b>\n\n` +
        'I help you manage and respond to app reviews on the <b>App Store</b> and <b>Play Store</b>.\n\n' +
        '🔹 I monitor your apps for new reviews\n' +
        '🔹 I suggest AI-generated responses\n' +
        '🔹 You approve, edit, or reject before sending\n\n' +
        '<b>Get started:</b>\n' +
        '1️⃣ /account - Connect your developer account\n' +
        '2️⃣ Wait for reviews to come in!\n\n' +
        'Use /help to see all commands.',
        { parse_mode: 'HTML' }
    );
}

/**
 * Handle /help command - Show available commands
 */
export async function handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
        '📖 <b>Available Commands</b>\n\n' +
        '<b>Setup:</b>\n' +
        '/account - Connect a developer account (App Store/Play Store)\n' +
        '/accounts - View and manage connected accounts\n' +
        '/apps - View all discovered apps\n\n' +
        '<b>Settings:</b>\n' +
        '/preferences - Configure auto-approve and notifications\n\n' +
        '<b>Reviews:</b>\n' +
        '/review - Go through reviews one by one\n' +
        '/poll - Fetch new reviews now\n' +
        '/stats - View review statistics\n\n' +
        '<b>Other:</b>\n' +
        '/help - Show this help message\n' +
        '/cancel - Cancel current operation',
        { parse_mode: 'HTML' }
    );
}

/**
 * Handle /accounts command - List user's connected accounts
 */
export async function handleAccounts(ctx: Context): Promise<void> {
    logger.debug('handleAccounts called');
    const from = ctx.from;
    if (!from) {
        logger.warn('Unable to identify user');
        await ctx.reply('Unable to identify user.');
        return;
    }

    const user = await supabase.getUserByTelegramId(from.id);
    if (!user) {
        logger.debug('User not registered', { telegramId: from.id });
        await ctx.reply('Please use /start first to register.');
        return;
    }

    const accounts = await supabase.getAccountsByUser(user.id);
    logger.debug('Accounts retrieved', { userId: user.id, accountCount: accounts.length });

    if (accounts.length === 0) {
        await ctx.reply(
            '🔗 <b>Connected Accounts</b>\n\n' +
            'No accounts connected yet.\n\n' +
            'Use /account to connect your App Store Connect or Google Play account.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    let message = '🔗 <b>Connected Accounts</b>\n\n';

    for (const account of accounts) {
        const platformName = account.account_type === 'app_store_connect' ? 'App Store Connect' : 'Google Play';
        const statusText = account.is_valid ? '' : ' · <i>invalid credentials</i>';

        // Count apps linked to this account
        const apps = await supabase.getAppsByAccount(account.id);
        const appsText = `${apps.length} app${apps.length === 1 ? '' : 's'}`;

        // Show key identifier for the account
        let keyInfo = '';
        if (account.account_type === 'app_store_connect' && account.apple_key_id) {
            keyInfo = ` (${account.apple_key_id})`;
        } else if (account.account_type === 'google_play') {
            try {
                const parsed = JSON.parse(account.credential_data);
                if (parsed.project_id) {
                    keyInfo = ` (${parsed.project_id})`;
                }
            } catch {
                // Ignore parse errors
            }
        }

        message += `<b>${platformName}</b>${statusText}\n`;
        message += `${appsText}${keyInfo}\n\n`;
    }

    const buttons = accounts.map((account) => {
        let keyId = '';
        if (account.account_type === 'app_store_connect' && account.apple_key_id) {
            keyId = account.apple_key_id;
        } else if (account.account_type === 'google_play') {
            try {
                const parsed = JSON.parse(account.credential_data);
                if (parsed.project_id) {
                    keyId = parsed.project_id;
                }
            } catch {
                // Ignore parse errors
            }
        }
        const label = keyId ? `Remove ${keyId}` : `Remove account`;
        return [Markup.button.callback(label, `delete_account_${account.id}`)];
    });

    await ctx.reply(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons),
    });
}

/**
 * Handle /apps command - List user's apps (from all accounts)
 */
export async function handleApps(ctx: Context): Promise<void> {
    logger.debug('handleApps called');
    const from = ctx.from;
    if (!from) {
        logger.warn('Unable to identify user');
        await ctx.reply('Unable to identify user.');
        return;
    }

    const user = await supabase.getUserByTelegramId(from.id);
    if (!user) {
        logger.debug('User not registered', { telegramId: from.id });
        await ctx.reply('Please use /start first to register.');
        return;
    }

    const apps = await supabase.getAppsByUser(user.id);
    logger.debug('Apps retrieved', { userId: user.id, appCount: apps.length });

    if (apps.length === 0) {
        await ctx.reply(
            '📱 <b>Your Apps</b>\n\n' +
            'No apps found yet.\n\n' +
            'Use /account to connect a developer account. ' +
            'Apps will be automatically discovered from App Store Connect, ' +
            'or you can add Play Store apps manually.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    let message = `📱 <b>Your Apps (${apps.length})</b>\n\n`;

    for (const app of apps) {
        const platformLabel = app.store === 'app_store' ? 'iOS' : 'Android';

        message += `<b>${escapeHtml(app.name)}</b> (${platformLabel})\n`;
        message += `<code>${escapeHtml(app.store_id)}</code>\n`;
        message += '\n';
    }

    await ctx.reply(message, { parse_mode: 'HTML' });
}

/**
 * Handle account deletion callback
 */
export async function handleDeleteAccount(ctx: Context, accountId: string): Promise<void> {
    logger.debug('handleDeleteAccount called', { accountId });
    if (!ctx.callbackQuery) return;

    await ctx.answerCbQuery();

    const account = await supabase.getAccountById(accountId);
    if (!account) {
        logger.warn('Account not found', { accountId });
        await ctx.editMessageText('❌ Account not found.');
        return;
    }

    logger.debug('Showing delete confirmation', { accountId, accountName: account.name });

    const platformName = account.account_type === 'app_store_connect' ? 'App Store Connect' : 'Google Play';

    await ctx.editMessageText(
        `⚠️ <b>Delete Account</b>\n\n` +
        `Are you sure you want to delete <b>${escapeHtml(account.name)}</b>?\n\n` +
        `Platform: ${platformName}\n\n` +
        '<i>This will also remove all associated apps and their reviews.</i>',
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Yes, delete', `confirm_delete_account_${accountId}`)],
                [Markup.button.callback('Cancel', 'cancel_delete')],
            ]),
        }
    );
}

/**
 * Handle account deletion confirmation
 */
export async function handleConfirmDeleteAccount(ctx: Context, accountId: string): Promise<void> {
    logger.debug('handleConfirmDeleteAccount called', { accountId });
    if (!ctx.callbackQuery) return;

    await ctx.answerCbQuery();

    try {
        const account = await supabase.getAccountById(accountId);
        logger.debug('Deleting account', { accountId, accountName: account?.name });
        await supabase.deleteAccount(accountId);
        logger.info('Account deleted', { accountId, accountName: account?.name });

        await ctx.editMessageText(
            `✅ <b>${escapeHtml(account?.name || 'Account')}</b> has been deleted.`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to delete account', { accountId, error: errorMessage });
        await ctx.editMessageText(`❌ Failed to delete account: ${errorMessage}`);
    }
}

/**
 * Handle /stats command - Show review statistics
 */
export async function handleStats(ctx: Context): Promise<void> {
    logger.debug('handleStats called');
    const from = ctx.from;
    if (!from) {
        logger.warn('Unable to identify user');
        await ctx.reply('Unable to identify user.');
        return;
    }

    const user = await supabase.getUserByTelegramId(from.id);
    if (!user) {
        logger.debug('User not registered', { telegramId: from.id });
        await ctx.reply('Please use /start first to register.');
        return;
    }

    const accounts = await supabase.getAccountsByUser(user.id);
    const apps = await supabase.getAppsByUser(user.id);

    let iosApps = 0;
    let androidApps = 0;
    for (const app of apps) {
        if (app.store === 'app_store') iosApps++;
        if (app.store === 'play_store') androidApps++;
    }

    logger.debug('Stats retrieved', { userId: user.id, accountCount: accounts.length, appCount: apps.length });

    await ctx.reply(
        '📊 <b>Your Statistics</b>\n\n' +
        `🔗 Connected accounts: ${accounts.length}\n` +
        `📱 Apps monitored: ${apps.length}\n` +
        `   🍎 iOS: ${iosApps}\n` +
        `   🤖 Android: ${androidApps}\n\n` +
        '<i>Detailed review statistics coming soon!</i>',
        { parse_mode: 'HTML' }
    );
}
