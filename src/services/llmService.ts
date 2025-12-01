/**
 * LLM Service using OpenRouter API
 * Generates contextual responses to app reviews
 */

import OpenAI from 'openai';
import { llmLogger as logger } from '../utils/logger';

const DEFAULT_MODEL = 'anthropic/claude-opus-4.5';

interface GenerateResponseOptions {
    appName: string;
    reviewRating: number;
    reviewTitle?: string | null;
    reviewBody: string;
    reviewerName?: string;
    store: 'app_store' | 'play_store';
    maxLength?: number; // Play Store has 350 char limit
    customInstructions?: string;
}

// Prevent OpenAI SDK from enabling its own debug logging
// The SDK checks for DEBUG env var and logs as "OpenAI:DEBUG" which is confusing since we use OpenRouter
// We save/restore DEBUG to only affect the OpenAI client initialization
const savedDebug = process.env.DEBUG;
delete process.env.DEBUG;

class LLMService {
    private client: OpenAI;
    private model: string;
    private baseSystemPrompt: string;

    constructor() {
        const apiKey = process.env.OPENROUTER_API_KEY;
        const systemPrompt = process.env.SYSTEM_PROMPT?.trim();

        if (!apiKey) {
            throw new Error('Missing OPENROUTER_API_KEY environment variable');
        }
        if (!systemPrompt) {
            throw new Error('Missing SYSTEM_PROMPT environment variable');
        }

        // Using OpenAI SDK as a generic client for OpenRouter API
        this.client = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey,
        });

        this.model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
        this.baseSystemPrompt = systemPrompt;
        logger.debug('LLM Service initialized', { model: this.model });
    }

    getModel(): string {
        return this.model;
    }

    /**
     * Generate a response to a customer review
     */
    async generateReviewResponse(options: GenerateResponseOptions): Promise<string> {
        const {
            appName,
            reviewRating,
            reviewTitle,
            reviewBody,
            reviewerName,
            store,
            maxLength = store === 'play_store' ? 350 : 5000,
            customInstructions,
        } = options;

        logger.debug('generateReviewResponse called', {
            appName,
            reviewRating,
            reviewTitle,
            store,
            maxLength,
            hasCustomInstructions: !!customInstructions,
        });

        const systemPrompt = this.buildSystemPrompt(appName, store, maxLength, customInstructions);
        const userPrompt = this.buildUserPrompt(reviewRating, reviewTitle, reviewBody, reviewerName);

        logger.debug('Sending request to OpenRouter API', {
            model: this.model,
            systemPromptLength: systemPrompt.length,
            userPromptLength: userPrompt.length,
        });

        const startTime = Date.now();
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 500,
            temperature: 0.7,
        });
        const duration = Date.now() - startTime;

        logger.debug('OpenRouter API response received', {
            duration: `${duration}ms`,
            finishReason: response.choices[0]?.finish_reason,
            usage: response.usage,
        });

        const generatedText = response.choices[0]?.message?.content?.trim() || '';

        // Log the generated response (truncated for readability)
        logger.debug('Generated response text', {
            fullLength: generatedText.length,
            text: generatedText.length > 200
                ? generatedText.substring(0, 200) + '...'
                : generatedText,
        });

        // Ensure we don't exceed max length
        if (generatedText.length > maxLength) {
            logger.debug('Response exceeds max length, truncating', {
                originalLength: generatedText.length,
                maxLength,
            });
            // Find a good breakpoint near the limit
            const truncated = generatedText.slice(0, maxLength - 3);
            const lastPeriod = truncated.lastIndexOf('.');
            const lastSpace = truncated.lastIndexOf(' ');

            if (lastPeriod > maxLength * 0.7) {
                return truncated.slice(0, lastPeriod + 1);
            } else if (lastSpace > maxLength * 0.8) {
                return truncated.slice(0, lastSpace) + '...';
            }
            return truncated + '...';
        }

        logger.debug('Response generated successfully', { responseLength: generatedText.length });
        return generatedText;
    }

    private buildSystemPrompt(appName: string, store: string, maxLength: number, customInstructions?: string): string {
        const storeDisplay = store === 'app_store' ? 'App Store' : 'Google Play Store';

        const basePrompt = this.baseSystemPrompt.replace(/\${maxLength}/g, String(maxLength));

        let prompt = `${basePrompt}

Context:
- App: "${appName}"
- Store: ${storeDisplay}`;

        if (customInstructions && customInstructions.trim()) {
            prompt += `\n\nADDITIONAL INSTRUCTIONS FROM THE APP OWNER:\n${customInstructions.trim()}`;
        }

        return prompt;
    }

    private buildUserPrompt(
        rating: number,
        title: string | null | undefined,
        body: string,
        reviewerName?: string
    ): string {
        let prompt = `Please generate a response to the following ${rating}-star review:\n\n`;

        if (reviewerName) {
            prompt += `Reviewer: ${reviewerName}\n`;
        }

        prompt += `Rating: ${'⭐'.repeat(rating)}\n`;

        if (title) {
            prompt += `Title: ${title}\n`;
        }

        prompt += `Review: ${body}`;

        return prompt;
    }

    /**
     * Generate a shorter, refined response from an existing draft
     */
    async refineResponse(
        originalResponse: string,
        feedback: string,
        maxLength: number = 350
    ): Promise<string> {
        logger.debug('refineResponse called', {
            originalLength: originalResponse.length,
            feedbackLength: feedback.length,
            maxLength,
        });

        const startTime = Date.now();
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are editing a customer support response. Revise the response based on the feedback while keeping it professional and within ${maxLength} characters.`,
                },
                {
                    role: 'user',
                    content: `Original response:\n${originalResponse}\n\nFeedback: ${feedback}\n\nPlease provide the revised response:`,
                },
            ],
            max_tokens: 400,
            temperature: 0.5,
        });
        const duration = Date.now() - startTime;

        logger.debug('Refine response completed', { duration: `${duration}ms` });

        const refined = response.choices[0]?.message?.content?.trim() || originalResponse;
        return refined.slice(0, maxLength);
    }
}

export const llmService = new LLMService();

// Restore DEBUG env var for our own logging after OpenAI SDK is initialized
if (savedDebug) {
    process.env.DEBUG = savedDebug;
}
