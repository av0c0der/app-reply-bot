/**
 * Telegram Bot Scenes - Account Setup Wizard
 * Multi-step conversation flow for adding developer accounts and discovering apps
 * Supports both App Store Connect and Google Play accounts
 */

import { Scenes, Markup } from 'telegraf';
import { supabase, Account } from '../services/supabase';
import { appStoreClient, DiscoveredApp } from '../services/appStoreClient';
import { playStoreScraper, PlayStoreAppInfo } from '../services/playStoreScraper';
import {
    validateAppleP8,
    validateAppleKeyId,
    validateAppleIssuerId,
    validateGoogleServiceAccount,
} from '../services/credentialValidator';
import { triggerUserPoll } from '../bot';

interface AccountWizardSession extends Scenes.WizardSessionData {
    accountType?: 'app_store_connect' | 'google_play';
    accountName?: string;
    credentialData?: string;
    appleKeyId?: string;
    appleIssuerId?: string;
    discoveredApps?: DiscoveredApp[];
    selectedAppIds?: Set<string>;
    // For Google Play manual package entry
    packageNames?: string[];
}

type AccountContext = Scenes.WizardContext<AccountWizardSession>;

// Step 0: Process account type selection (after enter shows prompt)
const processAccountTypeSelection = async (ctx: AccountContext) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        await ctx.reply('Please select an account type using the buttons above.');
        return;
    }

    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel_account') {
        await ctx.editMessageText('❌ Account setup cancelled.');
        return ctx.scene.leave();
    }

    if (data === 'account_app_store') {
        ctx.scene.session.accountType = 'app_store_connect';
        await ctx.editMessageText(
            '🍎 <b>App Store Connect Setup</b>\n\n' +
            'Please upload your API key file (.p8).\n\n' +
            '<i>You can create API keys in App Store Connect → Users and Access → Integrations → App Store Connect API</i>',
            { parse_mode: 'HTML' }
        );
        return ctx.wizard.next();
    }

    if (data === 'account_google_play') {
        ctx.scene.session.accountType = 'google_play';
        await ctx.editMessageText(
            '🤖 <b>Google Play Console Setup</b>\n\n' +
            'Please upload your service account JSON file.\n\n' +
            '<i>Create this in Google Cloud Console → IAM & Admin → Service Accounts</i>',
            { parse_mode: 'HTML' }
        );
        return ctx.wizard.next();
    }
};

// Step 1: Process credential file upload
const processCredentialFile = async (ctx: AccountContext) => {
    const accountType = ctx.scene.session.accountType!;

    // Handle document upload
    if (ctx.message && 'document' in ctx.message) {
        const document = ctx.message.document;

        try {
            const fileLink = await ctx.telegram.getFileLink(document.file_id);
            const response = await fetch(fileLink.href);
            const content = await response.text();

            if (accountType === 'app_store_connect') {
                const validation = validateAppleP8(content);
                if (!validation.valid) {
                    await ctx.reply(`❌ ${validation.error}\n\nPlease upload a valid .p8 file.`);
                    return;
                }

                ctx.scene.session.credentialData = validation.data!.privateKey;

                await ctx.reply(
                    '✅ Private key validated!\n\n' +
                    'Now please enter your <b>Key ID</b> (10 characters, found in App Store Connect):',
                    { parse_mode: 'HTML' }
                );

                return ctx.wizard.next();
            } else {
                // Google Play
                const validation = validateGoogleServiceAccount(content);
                if (!validation.valid) {
                    await ctx.reply(`❌ ${validation.error}\n\nPlease upload a valid service account JSON file.`);
                    return;
                }

                ctx.scene.session.credentialData = content;
                ctx.scene.session.accountName = validation.data!.projectId;

                // Google Play doesn't have app discovery API, so ask for links
                await ctx.reply(
                    '✅ <b>Service Account Validated!</b>\n\n' +
                    `Project: <code>${validation.data!.projectId}</code>\n` +
                    `Service Account: <code>${validation.data!.clientEmail}</code>\n\n` +
                    'Now, please send me your apps. You can provide:\n\n' +
                    '• <b>Developer page link</b> (fetches all apps):\n' +
                    '  <code>https://play.google.com/store/apps/dev?id=123456</code>\n\n' +
                    '• <b>Individual app links</b> (one per line):\n' +
                    '  <code>https://play.google.com/store/apps/details?id=com.example.app</code>\n\n' +
                    '• <b>Package names</b> (one per line):\n' +
                    '  <code>com.example.app</code>',
                    { parse_mode: 'HTML' }
                );

                return ctx.wizard.selectStep(4); // Skip to package name entry
            }
        } catch (error) {
            await ctx.reply('❌ Failed to download the file. Please try again.');
            return;
        }
    }

    // Handle text input (for .p8 content pasted directly)
    if (ctx.message && 'text' in ctx.message) {
        const text = ctx.message.text;

        if (text.startsWith('/')) {
            return; // Ignore commands
        }

        if (accountType === 'app_store_connect' && text.includes('-----BEGIN PRIVATE KEY-----')) {
            const validation = validateAppleP8(text);
            if (!validation.valid) {
                await ctx.reply(`❌ ${validation.error}\n\nPlease try again.`);
                return;
            }

            ctx.scene.session.credentialData = validation.data!.privateKey;

            await ctx.reply(
                '✅ Private key validated!\n\n' +
                'Now please enter your <b>Key ID</b> (10 characters):',
                { parse_mode: 'HTML' }
            );

            return ctx.wizard.next();
        }
    }

    await ctx.reply('Please upload your credential file as a document.');
};

// Step 2 (Apple only): Get Key ID
const processAppleKeyId = async (ctx: AccountContext) => {
    if (!ctx.message || !('text' in ctx.message)) {
        await ctx.reply('Please enter your Key ID:');
        return;
    }

    const keyId = ctx.message.text.trim();

    if (keyId.startsWith('/')) {
        return;
    }

    const validation = validateAppleKeyId(keyId);

    if (!validation.valid) {
        await ctx.reply(`❌ ${validation.error}\n\nPlease try again:`);
        return;
    }

    ctx.scene.session.appleKeyId = validation.data;

    await ctx.reply(
        '✅ Key ID validated!\n\n' +
        'Now please enter your <b>Issuer ID</b> (UUID format):',
        { parse_mode: 'HTML' }
    );

    return ctx.wizard.next();
};

// Step 3 (Apple only): Get Issuer ID and discover apps
const processAppleIssuerId = async (ctx: AccountContext) => {
    if (!ctx.message || !('text' in ctx.message)) {
        await ctx.reply('Please enter your Issuer ID:');
        return;
    }

    const issuerId = ctx.message.text.trim();

    if (issuerId.startsWith('/')) {
        return;
    }

    const validation = validateAppleIssuerId(issuerId);

    if (!validation.valid) {
        await ctx.reply(`❌ ${validation.error}\n\nPlease try again:`);
        return;
    }

    ctx.scene.session.appleIssuerId = validation.data;

    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.reply('❌ User not found. Please use /start first.');
        return ctx.scene.leave();
    }

    // Show loading message
    const loadingMsg = await ctx.reply('🔍 Discovering apps from App Store Connect...');

    try {
        // Store the account first
        const accountId = await supabase.storeAccountCredential(
            user.id,
            'app_store_connect',
            'App Store Connect',
            ctx.scene.session.credentialData!,
            ctx.scene.session.appleKeyId,
            validation.data
        );

        const account = await supabase.getAccountById(accountId);
        if (!account) {
            throw new Error('Failed to create account');
        }

        // Discover apps
        const apps = await appStoreClient.discoverAppsWithAccount(account);
        ctx.scene.session.discoveredApps = apps;

        await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);

        if (apps.length === 0) {
            await ctx.reply(
                '✅ <b>Account Connected!</b>\n\n' +
                'No apps found in this App Store Connect account.\n\n' +
                'Make sure your API key has access to your apps.',
                { parse_mode: 'HTML' }
            );
            return ctx.scene.leave();
        }

        // Save all apps and enable them by default
        for (const app of apps) {
            await supabase.upsertApp({
                user_id: user.id,
                account_id: account.id,
                name: app.name,
                bundle_id: app.bundleId,
                store_id: app.storeId,
                store: 'app_store',
                is_auto_discovered: true,
            });
        }

        const appList = apps.map((app, i) => `${i + 1}. ${app.name}`).join('\n');

        await ctx.reply(
            '✅ <b>Account Connected Successfully!</b>\n\n' +
            `Found <b>${apps.length} app(s)</b> in your App Store Connect account:\n\n` +
            `${appList}\n\n` +
            '🔄 Fetching reviews now...',
            { parse_mode: 'HTML' }
        );

        // Trigger initial poll for new reviews
        triggerUserPoll(user.id).catch(() => { /* ignore errors */ });

        return ctx.scene.leave();
    } catch (error) {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`❌ Failed to connect account: ${errorMessage}`);
        return ctx.scene.leave();
    }
};

// Step 4 (Google Play): Get package names
const processPackageNames = async (ctx: AccountContext) => {
    if (!ctx.message || !('text' in ctx.message)) {
        await ctx.reply('Please enter your app package names (one per line):');
        return;
    }

    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
        return;
    }

    // Parse input lines - could be URLs, package names, or developer links
    const lines = text.split(/[\n,]/).map((l) => l.trim()).filter((l) => l.length > 0);

    if (lines.length === 0) {
        await ctx.reply(
            '❌ No input provided.\n\n' +
            'Please send app links, developer page link, or package names.',
        );
        return;
    }

    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.reply('❌ User not found. Please use /start first.');
        return ctx.scene.leave();
    }

    // Show loading message
    const loadingMsg = await ctx.reply('🔍 Fetching app information from Play Store...');

    try {
        // Fetch apps using the scraper
        const { apps, errors } = await playStoreScraper.fetchPlayStoreApps(lines);

        await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);

        if (apps.length === 0) {
            let errorMsg = '❌ No valid apps found.\n\n';
            if (errors.length > 0) {
                errorMsg += 'Errors:\n' + errors.map((e) => `• ${e}`).join('\n') + '\n\n';
            }
            errorMsg += 'Please try again with valid app links or package names.';
            await ctx.reply(errorMsg);
            return;
        }

        // Show warnings for any errors
        if (errors.length > 0) {
            await ctx.reply(
                `⚠️ Some inputs couldn't be processed:\n${errors.map((e) => `• ${e}`).join('\n')}`
            );
        }

        // Store the account
        const accountId = await supabase.storeAccountCredential(
            user.id,
            'google_play',
            ctx.scene.session.accountName || 'Google Play',
            ctx.scene.session.credentialData!
        );

        const account = await supabase.getAccountById(accountId);
        if (!account) {
            throw new Error('Failed to create account');
        }

        // Create apps for each discovered app
        for (const app of apps) {
            await supabase.upsertApp({
                user_id: user.id,
                account_id: account.id,
                name: app.name,
                bundle_id: app.packageName,
                store_id: app.packageName,
                store: 'play_store',
                is_auto_discovered: lines.some((l) => l.includes('dev?id=') || l.includes('developer?id=')),
            });
        }

        const appList = apps.map((app, i) => `${i + 1}. <b>${app.name}</b>\n   <code>${app.packageName}</code>`).join('\n');

        await ctx.reply(
            '✅ <b>Account Connected Successfully!</b>\n\n' +
            `Found <b>${apps.length} app(s)</b> to monitor:\n\n` +
            `${appList}\n\n` +
            '🔄 Fetching reviews now...',
            { parse_mode: 'HTML' }
        );

        // Trigger initial poll for new reviews
        triggerUserPoll(user.id).catch(() => { /* ignore errors */ });

        return ctx.scene.leave();
    } catch (error) {
        try {
            await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
        } catch {
            // Message might already be deleted
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`❌ Failed to connect account: ${errorMessage}`);
        return ctx.scene.leave();
    }
};

// Create the wizard scene
export const accountScene = new Scenes.WizardScene<AccountContext>(
    'account-wizard',
    processAccountTypeSelection,  // Step 0: Process account type selection
    processCredentialFile,        // Step 1: Process file upload
    processAppleKeyId,            // Step 2: Apple Key ID
    processAppleIssuerId,         // Step 3: Apple Issuer ID + discover apps
    processPackageNames           // Step 4: Google Play package names
);

// Trigger first step on scene enter
accountScene.enter(async (ctx) => {
    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.reply('❌ User not found. Please use /start first.');
        return ctx.scene.leave();
    }

    // Check existing accounts
    const accounts = await supabase.getAccountsByUser(user.id);

    let statusMessage = '';
    if (accounts.length > 0) {
        const appStoreCount = accounts.filter((a) => a.account_type === 'app_store_connect').length;
        const playStoreCount = accounts.filter((a) => a.account_type === 'google_play').length;
        statusMessage = `\n\n<i>Connected: ${appStoreCount} App Store, ${playStoreCount} Google Play</i>`;
    }

    const buttons = [
        [Markup.button.callback('🍎 App Store Connect', 'account_app_store')],
        [Markup.button.callback('🤖 Google Play Console', 'account_google_play')],
        [Markup.button.callback('❌ Cancel', 'cancel_account')],
    ];

    await ctx.reply(
        '🔐 <b>Connect Developer Account</b>\n\n' +
        'Select which platform to connect:' +
        statusMessage,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons),
        }
    );
});

// Handle cancel action
accountScene.action('cancel_account', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('❌ Account setup cancelled.');
    return ctx.scene.leave();
});

// Handle account type selection
accountScene.action('account_app_store', async (ctx) => {
    return processAccountTypeSelection(ctx as AccountContext);
});

accountScene.action('account_google_play', async (ctx) => {
    return processAccountTypeSelection(ctx as AccountContext);
});

// Handle /cancel command
accountScene.command('cancel', async (ctx) => {
    await ctx.reply('❌ Account setup cancelled.');
    return ctx.scene.leave();
});

// Handle other commands - leave scene so they can be processed
const leaveCommands = ['start', 'help', 'apps', 'account', 'preferences', 'review', 'pending', 'poll', 'stats'];
for (const cmd of leaveCommands) {
    accountScene.command(cmd, async (ctx) => {
        await ctx.scene.leave();
    });
}
