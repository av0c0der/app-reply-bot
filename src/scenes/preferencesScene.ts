/**
 * Telegram Bot Scenes - User Preferences Wizard
 * Manage user settings for review responses
 */

import { Scenes, Markup } from 'telegraf';
import { supabase, DEFAULT_PREFERENCES } from '../services/supabase';

interface PreferencesWizardState {
    awaitingCustomInstructions?: boolean;
}

type PreferencesContext = Scenes.WizardContext & {
    scene: Scenes.SceneContextScene<Scenes.WizardContext, Scenes.WizardSessionData> & {
        state: PreferencesWizardState;
    };
};

// Helper to escape HTML special characters
const escapeHtml = (text: string): string => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

// Helper to build preferences message
const buildPreferencesMessage = (prefs: typeof DEFAULT_PREFERENCES): string => {
    const autoApproveStatus = prefs.auto_approve_positive ? '✅ ON' : '❌ OFF';
    const notificationsStatus = prefs.notification_enabled ? '✅ ON' : '❌ OFF';
    const escapedInstructions = prefs.custom_instructions
        ? escapeHtml(prefs.custom_instructions)
        : null;
    const instructionsStatus = escapedInstructions
        ? `<i>"${escapedInstructions.length > 50 ? escapedInstructions.slice(0, 50) + '...' : escapedInstructions}"</i>`
        : '<i>Not set</i>';

    return '⚙️ <b>Your Preferences</b>\n\n' +
        `1️⃣ <b>Auto-approve positive reviews (4-5 ⭐):</b> ${autoApproveStatus}\n` +
        '<i>When enabled, AI-generated responses for positive reviews are sent automatically.</i>\n\n' +
        `2️⃣ <b>Notifications:</b> ${notificationsStatus}\n` +
        '<i>When enabled, you receive notifications for new reviews.</i>\n\n' +
        `3️⃣ <b>Custom AI Instructions:</b> ${instructionsStatus}\n` +
        '<i>Additional instructions for generating AI responses.</i>\n\n' +
        'What would you like to change?';
};

// Helper to build preferences keyboard
const buildPreferencesKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🤖 Toggle Auto-approve', 'toggle_auto_approve')],
        [Markup.button.callback('🔔 Toggle Notifications', 'toggle_notifications')],
        [Markup.button.callback('📝 Set Custom Instructions', 'set_custom_instructions')],
        [Markup.button.callback('✅ Done', 'preferences_done')],
    ]);
};

// Step 1: Show current preferences
const showPreferences = async (ctx: PreferencesContext) => {
    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.reply('❌ User not found. Please use /start first.');
        return ctx.scene.leave();
    }

    const preferences = await supabase.getUserPreferences(user.id);
    const prefs = preferences?.preferences || DEFAULT_PREFERENCES;

    await ctx.reply(buildPreferencesMessage(prefs), {
        parse_mode: 'HTML',
        ...buildPreferencesKeyboard(),
    });

    return ctx.wizard.next();
};

// Step 2: Process preference changes
const processPreferenceChange = async (ctx: PreferencesContext) => {
    // Check if we're waiting for custom instructions text
    if (ctx.scene.state.awaitingCustomInstructions && ctx.message && 'text' in ctx.message) {
        const instructions = ctx.message.text.trim();

        const user = await supabase.getUserByTelegramId(ctx.from!.id);
        if (!user) {
            await ctx.reply('❌ User not found.');
            return ctx.scene.leave();
        }

        // Save the custom instructions (empty string clears them)
        if (instructions.toLowerCase() === 'clear') {
            await supabase.updateUserPreferences(user.id, {
                custom_instructions: undefined,
            });
            await ctx.reply('✅ Custom instructions cleared!');
        } else {
            await supabase.updateUserPreferences(user.id, {
                custom_instructions: instructions,
            });
            await ctx.reply('✅ Custom instructions saved!');
        }

        ctx.scene.state.awaitingCustomInstructions = false;

        // Show updated preferences
        const preferences = await supabase.getUserPreferences(user.id);
        const prefs = preferences?.preferences || DEFAULT_PREFERENCES;

        await ctx.reply(buildPreferencesMessage(prefs), {
            parse_mode: 'HTML',
            ...buildPreferencesKeyboard(),
        });
        return;
    }

    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        await ctx.reply('Please use the buttons above to change preferences.');
        return;
    }

    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'preferences_done') {
        await ctx.editMessageText('✅ Preferences saved!');
        return ctx.scene.leave();
    }

    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.editMessageText('❌ User not found.');
        return ctx.scene.leave();
    }

    const preferences = await supabase.getUserPreferences(user.id);
    const prefs = preferences?.preferences || DEFAULT_PREFERENCES;

    if (data === 'toggle_auto_approve') {
        const newValue = !prefs.auto_approve_positive;
        await supabase.updateUserPreferences(user.id, {
            auto_approve_positive: newValue,
        });

        await ctx.answerCbQuery(
            newValue
                ? '✅ Auto-approve enabled for positive reviews'
                : '❌ Auto-approve disabled'
        );
    } else if (data === 'toggle_notifications') {
        const newValue = !prefs.notification_enabled;
        await supabase.updateUserPreferences(user.id, {
            notification_enabled: newValue,
        });

        await ctx.answerCbQuery(
            newValue ? '✅ Notifications enabled' : '❌ Notifications disabled'
        );
    } else if (data === 'set_custom_instructions') {
        ctx.scene.state.awaitingCustomInstructions = true;
        const escapedInstructions = prefs.custom_instructions
            ? escapeHtml(prefs.custom_instructions)
            : 'Not set';
        await ctx.editMessageText(
            '📝 <b>Set Custom AI Instructions</b>\n\n' +
            'Enter custom instructions for the AI when generating review responses.\n\n' +
            'Examples:\n' +
            '• "Always sign off as John from Support Team"\n' +
            '• "Mention our premium support at support@example.com"\n' +
            '• "Keep responses under 200 characters"\n\n' +
            'Type your instructions below, or type "clear" to remove existing instructions.\n\n' +
            '<b>Current instructions:</b> ' + escapedInstructions,
            { parse_mode: 'HTML' }
        );
        return;
    }

    // Refresh the preferences display
    const updatedPreferences = await supabase.getUserPreferences(user.id);
    const updatedPrefs = updatedPreferences?.preferences || DEFAULT_PREFERENCES;

    await ctx.editMessageText(buildPreferencesMessage(updatedPrefs), {
        parse_mode: 'HTML',
        ...buildPreferencesKeyboard(),
    });
};

// Create the wizard scene
export const preferencesScene = new Scenes.WizardScene<PreferencesContext>(
    'preferences-wizard',
    processPreferenceChange  // Step 0: Handle button clicks
);

// Trigger first step on scene enter - show preferences UI
preferencesScene.enter(async (ctx) => {
    const user = await supabase.getUserByTelegramId(ctx.from!.id);
    if (!user) {
        await ctx.reply('❌ User not found. Please use /start first.');
        return ctx.scene.leave();
    }

    const preferences = await supabase.getUserPreferences(user.id);
    const prefs = preferences?.preferences || DEFAULT_PREFERENCES;

    await ctx.reply(buildPreferencesMessage(prefs), {
        parse_mode: 'HTML',
        ...buildPreferencesKeyboard(),
    });
});

// Handle toggle actions - keep user in the same step
preferencesScene.action('toggle_auto_approve', async (ctx) => {
    return processPreferenceChange(ctx as PreferencesContext);
});

preferencesScene.action('toggle_notifications', async (ctx) => {
    return processPreferenceChange(ctx as PreferencesContext);
});

preferencesScene.action('set_custom_instructions', async (ctx) => {
    return processPreferenceChange(ctx as PreferencesContext);
});

preferencesScene.action('preferences_done', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('✅ Preferences saved!');
    return ctx.scene.leave();
});

// Handle text input for custom instructions
preferencesScene.on('text', async (ctx) => {
    return processPreferenceChange(ctx as PreferencesContext);
});

// Handle /cancel command
preferencesScene.command('cancel', async (ctx) => {
    await ctx.reply('✅ Preferences saved!');
    return ctx.scene.leave();
});

// Handle other commands - leave scene so they can be processed
preferencesScene.command('start', async (ctx) => {
    await ctx.scene.leave();
});

preferencesScene.command('help', async (ctx) => {
    await ctx.scene.leave();
});

preferencesScene.command('apps', async (ctx) => {
    await ctx.scene.leave();
});

preferencesScene.command('addapp', async (ctx) => {
    await ctx.scene.leave();
});

preferencesScene.command('credentials', async (ctx) => {
    await ctx.scene.leave();
});

preferencesScene.command('preferences', async (ctx) => {
    await ctx.scene.leave();
});
