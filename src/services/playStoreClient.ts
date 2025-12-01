/**
 * Google Play Developer API Client
 * Handles authentication and review operations for Google Play Store
 * Uses accounts-based credential model
 */

import { google, androidpublisher_v3 } from 'googleapis';
import { supabase, Account } from './supabase';
import { playStoreLogger as logger } from '../utils/logger';

export interface ParsedPlayStoreReview {
    externalId: string;
    rating: number;
    title: string | null;
    body: string;
    reviewerName: string;
    reviewDate: string;
    language: string;
    hasResponse: boolean;
    androidOsVersion?: string;
    appVersionCode?: number;
    appVersionName?: string;
    device?: string;
}

export class PlayStoreClient {
    /**
     * Create authenticated Android Publisher client
     */
    private async createClient(
        credentialJson: string
    ): Promise<androidpublisher_v3.Androidpublisher> {
        logger.debug('Creating Android Publisher client');
        let credentials;
        try {
            credentials = JSON.parse(credentialJson);
        } catch (parseError) {
            const errorMsg = parseError instanceof Error ? parseError.message : 'Unknown parse error';
            logger.error('Failed to parse service account JSON', { error: errorMsg });
            throw new Error(`Invalid service account JSON: ${errorMsg}. Please re-upload your credentials.`);
        }

        if (!credentials.client_email || !credentials.private_key) {
            logger.error('Invalid service account JSON: missing required fields');
            throw new Error('Invalid service account JSON: missing client_email or private_key. Please ensure you uploaded the correct file.');
        }

        logger.debug('Service account parsed', { clientEmail: credentials.client_email });

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });

        return google.androidpublisher({
            version: 'v3',
            auth,
        });
    }

    /**
     * Fetch reviews for a package
     * Note: Google Play API only returns reviews from the last 7 days
     * If lastPollAt is provided, stops fetching when it encounters reviews older than that date
     */
    async fetchReviews(
        packageName: string,
        credentialJson: string,
        maxResults: number = 500,
        lastPollAt?: Date
    ): Promise<ParsedPlayStoreReview[]> {
        logger.debug('fetchReviews called', { packageName, maxResults, lastPollAt: lastPollAt?.toISOString() });
        const client = await this.createClient(credentialJson);

        const reviews: ParsedPlayStoreReview[] = [];
        let pageToken: string | undefined;
        let pageCount = 0;
        let reachedOldReviews = false;

        do {
            pageCount++;
            logger.debug(`Fetching page ${pageCount}`, { currentCount: reviews.length });
            const response = await client.reviews.list({
                packageName,
                maxResults: Math.min(maxResults - reviews.length, 100),
                token: pageToken,
            });

            if (response.data.reviews) {
                for (const review of response.data.reviews) {
                    const comment = review.comments?.[0]?.userComment;
                    if (!comment) continue;

                    const reviewDate = comment.lastModified?.seconds
                        ? new Date(parseInt(comment.lastModified.seconds) * 1000)
                        : new Date();

                    // If we have a lastPollAt and this review is older, stop processing
                    if (lastPollAt && reviewDate <= lastPollAt) {
                        logger.debug('Reached reviews older than last poll, stopping', {
                            reviewDate: reviewDate.toISOString(),
                            lastPollAt: lastPollAt.toISOString()
                        });
                        reachedOldReviews = true;
                        break;
                    }

                    // Check if there's a developer reply
                    const hasResponse = review.comments?.some((c) => c.developerComment) || false;

                    reviews.push({
                        externalId: review.reviewId || '',
                        rating: comment.starRating || 0,
                        title: null, // Play Store reviews don't have separate titles
                        body: comment.text || '',
                        reviewerName: review.authorName || 'Anonymous',
                        reviewDate: reviewDate.toISOString(),
                        language: comment.reviewerLanguage || 'en',
                        hasResponse,
                        androidOsVersion: comment.androidOsVersion?.toString(),
                        appVersionCode: comment.appVersionCode ?? undefined,
                        appVersionName: comment.appVersionName || undefined,
                        device: comment.device || undefined,
                    });
                }
            }

            pageToken = reachedOldReviews ? undefined : (response.data.tokenPagination?.nextPageToken || undefined);
        } while (pageToken && reviews.length < maxResults && !reachedOldReviews);

        logger.debug('fetchReviews completed', { totalReviews: reviews.length, pages: pageCount, stoppedEarly: reachedOldReviews });
        return reviews.slice(0, maxResults);
    }

    /**
     * Fetch only unresponded reviews
     * If lastPollAt is provided, only fetches reviews newer than that date
     */
    async fetchUnrespondedReviews(
        packageName: string,
        credentialJson: string,
        maxResults: number = 50,
        lastPollAt?: Date
    ): Promise<ParsedPlayStoreReview[]> {
        logger.debug('fetchUnrespondedReviews called', { packageName, maxResults, lastPollAt: lastPollAt?.toISOString() });
        const allReviews = await this.fetchReviews(packageName, credentialJson, maxResults * 2, lastPollAt);
        const unresponded = allReviews.filter((r) => !r.hasResponse).slice(0, maxResults);
        logger.debug('fetchUnrespondedReviews completed', { total: allReviews.length, unresponded: unresponded.length });
        return unresponded;
    }

    /**
     * Reply to a review
     * Note: Response text is limited to 350 characters on Play Store
     */
    async replyToReview(
        packageName: string,
        reviewId: string,
        replyText: string,
        credentialJson: string
    ): Promise<void> {
        logger.debug('replyToReview called', { packageName, reviewId, replyLength: replyText.length });
        // Enforce 350 character limit
        const truncatedReply = replyText.slice(0, 350);
        if (replyText.length > 350) {
            logger.debug('Reply truncated to 350 characters');
        }

        const client = await this.createClient(credentialJson);

        await client.reviews.reply({
            packageName,
            reviewId,
            requestBody: {
                replyText: truncatedReply,
            },
        });
        logger.debug('replyToReview completed', { reviewId });
    }

    /**
     * Fetch reviews for an app using account credentials
     */
    async fetchReviewsWithAccount(
        account: Account,
        packageName: string,
        lastPollAt?: Date
    ): Promise<ParsedPlayStoreReview[]> {
        logger.debug('fetchReviewsWithAccount called', { accountId: account.id, packageName, lastPollAt: lastPollAt?.toISOString() });

        if (!account.is_valid) {
            throw new Error('Account credentials are invalid. Please re-upload your service account JSON file.');
        }

        try {
            const reviews = await this.fetchUnrespondedReviews(packageName, account.credential_data, 50, lastPollAt);
            logger.debug('fetchReviewsWithAccount completed', { accountId: account.id, reviewCount: reviews.length });
            return reviews;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            // Check if it's an auth error
            if (
                errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('PERMISSION_DENIED') ||
                errorMessage.includes('UNAUTHENTICATED')
            ) {
                logger.warn('Auth error detected, invalidating account', { accountId: account.id, errorMessage });
                await supabase.invalidateAccount(account.id, errorMessage);
                throw new Error(
                    `Credentials are invalid: ${errorMessage}. Please re-upload your service account JSON file.`
                );
            }
            throw error;
        }
    }

    /**
     * Reply to review using account credentials
     */
    async replyWithAccount(
        account: Account,
        packageName: string,
        reviewExternalId: string,
        replyText: string
    ): Promise<void> {
        logger.debug('replyWithAccount called', { accountId: account.id, packageName, reviewExternalId });

        if (!account.is_valid) {
            throw new Error('Account credentials are invalid. Please re-upload your service account JSON file.');
        }

        try {
            await this.replyToReview(packageName, reviewExternalId, replyText, account.credential_data);
            logger.debug('replyWithAccount completed', { accountId: account.id, reviewExternalId });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            if (
                errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('PERMISSION_DENIED') ||
                errorMessage.includes('UNAUTHENTICATED')
            ) {
                logger.warn('Auth error detected during reply, invalidating account', { accountId: account.id, errorMessage });
                await supabase.invalidateAccount(account.id, errorMessage);
                throw new Error(
                    `Credentials are invalid: ${errorMessage}. Please re-upload your service account JSON file.`
                );
            }
            throw error;
        }
    }
}

export const playStoreClient = new PlayStoreClient();
