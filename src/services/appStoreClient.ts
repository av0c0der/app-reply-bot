/**
 * App Store Connect API Client
 * Handles authentication and review operations for Apple App Store
 * Uses accounts-based credential model
 */

import jwt from 'jsonwebtoken';
import { supabase, Account } from './supabase';
import { appStoreLogger as logger } from '../utils/logger';

interface AppStoreReview {
    id: string;
    type: 'customerReviews';
    attributes: {
        rating: number;
        title: string | null;
        body: string;
        reviewerNickname: string;
        createdDate: string;
        territory: string;
    };
    relationships?: {
        response?: {
            data: { id: string; type: string } | null;
        };
    };
}

interface AppStoreReviewsResponse {
    data: AppStoreReview[];
    links?: {
        next?: string;
    };
}

interface AppStoreApp {
    id: string;
    type: 'apps';
    attributes: {
        name: string;
        bundleId: string;
        sku: string;
        primaryLocale: string;
    };
}

interface AppStoreAppsResponse {
    data: AppStoreApp[];
    links?: {
        next?: string;
    };
}

export interface ParsedAppStoreReview {
    externalId: string;
    rating: number;
    title: string | null;
    body: string;
    reviewerName: string;
    reviewDate: string;
    territory: string;
    hasResponse: boolean;
}

export interface DiscoveredApp {
    storeId: string;
    name: string;
    bundleId: string;
}

export class AppStoreClient {
    private baseUrl = 'https://api.appstoreconnect.apple.com/v1';

    /**
     * Generate JWT for App Store Connect API authentication
     */
    private generateToken(privateKey: string, keyId: string, issuerId: string): string {
        logger.debug('Generating JWT token', { keyId, issuerId });
        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 20 * 60; // 20 minutes max

        const payload = {
            iss: issuerId,
            iat: now,
            exp: expiration,
            aud: 'appstoreconnect-v1',
        };

        const header = {
            alg: 'ES256' as const,
            kid: keyId,
            typ: 'JWT',
        };

        return jwt.sign(payload, privateKey, {
            algorithm: 'ES256',
            header,
        });
    }

    /**
     * Make authenticated request to App Store Connect API
     */
    private async request<T>(
        endpoint: string,
        token: string,
        method: 'GET' | 'POST' = 'GET',
        body?: Record<string, unknown>
    ): Promise<T> {
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

        logger.debugRequest(method, url, body);
        const startTime = Date.now();

        const response = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        const duration = Date.now() - startTime;

        if (!response.ok) {
            const errorBody = await response.text();
            let errorMessage = `App Store API error: ${response.status} ${response.statusText}`;

            try {
                const errorJson = JSON.parse(errorBody);
                if (errorJson.errors?.[0]?.detail) {
                    errorMessage = errorJson.errors[0].detail;
                }
            } catch {
                // Use default error message
            }

            logger.error(`API request failed: ${errorMessage}`, { status: response.status, duration: `${duration}ms` });
            throw new Error(errorMessage);
        }

        logger.debugResponse(method, url, response.status, { duration: `${duration}ms` });
        return response.json() as Promise<T>;
    }

    /**
     * List all apps accessible with the given credentials
     */
    async listApps(
        privateKey: string,
        keyId: string,
        issuerId: string
    ): Promise<DiscoveredApp[]> {
        logger.debug('listApps called');
        const token = this.generateToken(privateKey, keyId, issuerId);

        const apps: DiscoveredApp[] = [];
        let nextUrl: string | null = '/apps?limit=200';
        let pageCount = 0;

        while (nextUrl) {
            pageCount++;
            logger.debug(`Fetching apps page ${pageCount}`, { currentCount: apps.length });
            const apiResponse: AppStoreAppsResponse = await this.request<AppStoreAppsResponse>(nextUrl, token);

            for (const app of apiResponse.data) {
                apps.push({
                    storeId: app.id,
                    name: app.attributes.name,
                    bundleId: app.attributes.bundleId,
                });
            }

            nextUrl = apiResponse.links?.next || null;
        }

        logger.debug('listApps completed', { totalApps: apps.length, pages: pageCount });
        return apps;
    }

    /**
     * Fetch customer reviews for an app
     */
    async fetchReviews(
        appId: string,
        privateKey: string,
        keyId: string,
        issuerId: string,
        limit: number = 100
    ): Promise<ParsedAppStoreReview[]> {
        logger.debug('fetchReviews called', { appId, limit });
        const token = this.generateToken(privateKey, keyId, issuerId);

        const reviews: ParsedAppStoreReview[] = [];
        let nextUrl: string | null = `/apps/${appId}/customerReviews?limit=${Math.min(limit, 200)}&sort=-createdDate`;
        let pageCount = 0;

        while (nextUrl && reviews.length < limit) {
            pageCount++;
            logger.debug(`Fetching page ${pageCount}`, { currentCount: reviews.length });
            const apiResponse: AppStoreReviewsResponse = await this.request<AppStoreReviewsResponse>(nextUrl, token);

            for (const review of apiResponse.data) {
                reviews.push({
                    externalId: review.id,
                    rating: review.attributes.rating,
                    title: review.attributes.title,
                    body: review.attributes.body,
                    reviewerName: review.attributes.reviewerNickname,
                    reviewDate: review.attributes.createdDate,
                    territory: review.attributes.territory,
                    hasResponse: !!review.relationships?.response?.data,
                });
            }

            nextUrl = apiResponse.links?.next || null;
        }

        logger.debug('fetchReviews completed', { totalReviews: reviews.length, pages: pageCount });
        return reviews.slice(0, limit);
    }

    /**
     * Fetch only unresponded reviews (with pagination to get all)
     * If lastPollAt is provided, stops fetching when it encounters reviews older than that date
     */
    async fetchUnrespondedReviews(
        appId: string,
        privateKey: string,
        keyId: string,
        issuerId: string,
        lastPollAt?: Date
    ): Promise<ParsedAppStoreReview[]> {
        logger.debug('fetchUnrespondedReviews called', { appId, lastPollAt: lastPollAt?.toISOString() });
        const token = this.generateToken(privateKey, keyId, issuerId);

        const reviews: ParsedAppStoreReview[] = [];
        let nextUrl: string | null = `/apps/${appId}/customerReviews?limit=200&sort=-createdDate&exists[publishedResponse]=false`;
        let pageCount = 0;
        let reachedOldReviews = false;

        while (nextUrl && !reachedOldReviews) {
            pageCount++;
            logger.debug(`Fetching page ${pageCount}`, { currentCount: reviews.length });
            const apiResponse: AppStoreReviewsResponse = await this.request<AppStoreReviewsResponse>(nextUrl, token);

            for (const review of apiResponse.data) {
                const reviewDate = new Date(review.attributes.createdDate);

                // If we have a lastPollAt and this review is older, stop processing
                if (lastPollAt && reviewDate <= lastPollAt) {
                    logger.debug('Reached reviews older than last poll, stopping', {
                        reviewDate: review.attributes.createdDate,
                        lastPollAt: lastPollAt.toISOString()
                    });
                    reachedOldReviews = true;
                    break;
                }

                reviews.push({
                    externalId: review.id,
                    rating: review.attributes.rating,
                    title: review.attributes.title,
                    body: review.attributes.body,
                    reviewerName: review.attributes.reviewerNickname,
                    reviewDate: review.attributes.createdDate,
                    territory: review.attributes.territory,
                    hasResponse: false,
                });
            }

            nextUrl = reachedOldReviews ? null : (apiResponse.links?.next || null);
        }

        logger.debug('fetchUnrespondedReviews completed', { totalReviews: reviews.length, pages: pageCount, stoppedEarly: reachedOldReviews });
        return reviews;
    }

    /**
     * Post a response to a customer review
     */
    async postResponse(
        reviewId: string,
        responseBody: string,
        privateKey: string,
        keyId: string,
        issuerId: string
    ): Promise<void> {
        logger.debug('postResponse called', { reviewId, responseLength: responseBody.length });
        const token = this.generateToken(privateKey, keyId, issuerId);

        const body = {
            data: {
                type: 'customerReviewResponses',
                attributes: {
                    responseBody: responseBody,
                },
                relationships: {
                    review: {
                        data: {
                            type: 'customerReviews',
                            id: reviewId,
                        },
                    },
                },
            },
        };

        await this.request('/customerReviewResponses', token, 'POST', body);
        logger.debug('postResponse completed successfully', { reviewId });
    }

    /**
     * Discover all apps using account credentials
     */
    async discoverAppsWithAccount(account: Account): Promise<DiscoveredApp[]> {
        logger.debug('discoverAppsWithAccount called', { accountId: account.id });

        if (!account.is_valid) {
            throw new Error('Account credentials are invalid. Please re-upload your .p8 file.');
        }

        if (!account.apple_key_id || !account.apple_issuer_id) {
            throw new Error('Missing Apple Key ID or Issuer ID');
        }

        try {
            const apps = await this.listApps(
                account.credential_data,
                account.apple_key_id,
                account.apple_issuer_id
            );
            logger.debug('discoverAppsWithAccount completed', { accountId: account.id, appCount: apps.length });
            return apps;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (
                errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('FORBIDDEN') ||
                errorMessage.includes('NOT_AUTHORIZED')
            ) {
                logger.warn('Auth error detected, invalidating account', { accountId: account.id, errorMessage });
                await supabase.invalidateAccount(account.id, errorMessage);
                throw new Error(`Credentials are invalid: ${errorMessage}. Please re-upload your .p8 file.`);
            }
            throw error;
        }
    }

    /**
     * Fetch reviews for an app using account credentials
     */
    async fetchReviewsWithAccount(
        account: Account,
        storeId: string,
        lastPollAt?: Date
    ): Promise<ParsedAppStoreReview[]> {
        logger.debug('fetchReviewsWithAccount called', { accountId: account.id, storeId, lastPollAt: lastPollAt?.toISOString() });

        if (!account.is_valid) {
            throw new Error('Account credentials are invalid. Please re-upload your .p8 file.');
        }

        if (!account.apple_key_id || !account.apple_issuer_id) {
            throw new Error('Missing Apple Key ID or Issuer ID');
        }

        try {
            const reviews = await this.fetchUnrespondedReviews(
                storeId,
                account.credential_data,
                account.apple_key_id,
                account.apple_issuer_id,
                lastPollAt
            );
            logger.debug('fetchReviewsWithAccount completed', { accountId: account.id, reviewCount: reviews.length });
            return reviews;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (
                errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('FORBIDDEN') ||
                errorMessage.includes('NOT_AUTHORIZED')
            ) {
                logger.warn('Auth error detected, invalidating account', { accountId: account.id, errorMessage });
                await supabase.invalidateAccount(account.id, errorMessage);
                throw new Error(`Credentials are invalid: ${errorMessage}. Please re-upload your .p8 file.`);
            }
            throw error;
        }
    }

    /**
     * Post response using account credentials
     */
    async postResponseWithAccount(
        account: Account,
        reviewExternalId: string,
        responseBody: string
    ): Promise<void> {
        logger.debug('postResponseWithAccount called', { accountId: account.id, reviewExternalId });

        if (!account.is_valid) {
            throw new Error('Account credentials are invalid. Please re-upload your .p8 file.');
        }

        if (!account.apple_key_id || !account.apple_issuer_id) {
            throw new Error('Missing Apple Key ID or Issuer ID');
        }

        try {
            await this.postResponse(
                reviewExternalId,
                responseBody,
                account.credential_data,
                account.apple_key_id,
                account.apple_issuer_id
            );
            logger.debug('postResponseWithAccount completed', { accountId: account.id, reviewExternalId });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (
                errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('FORBIDDEN') ||
                errorMessage.includes('NOT_AUTHORIZED')
            ) {
                logger.warn('Auth error detected during post, invalidating account', { accountId: account.id, errorMessage });
                await supabase.invalidateAccount(account.id, errorMessage);
                throw new Error(`Credentials are invalid: ${errorMessage}. Please re-upload your .p8 file.`);
            }
            throw error;
        }
    }
}

export const appStoreClient = new AppStoreClient();
