/**
 * Play Store Scraper
 * Fetches app information from Google Play Store pages
 * Supports individual app links and developer page links
 */

import { playStoreLogger as logger } from '../utils/logger';

export interface PlayStoreAppInfo {
    packageName: string;
    name: string;
    iconUrl?: string;
}

export interface ParsedPlayStoreInput {
    type: 'app' | 'developer' | 'package';
    value: string; // packageName for app/package, developerId for developer
}

/**
 * Parse user input to determine the type of Play Store reference
 */
export function parsePlayStoreInput(input: string): ParsedPlayStoreInput | null {
    const trimmed = input.trim();

    // Check for app URL: https://play.google.com/store/apps/details?id=com.example.app
    const appUrlMatch = trimmed.match(
        /play\.google\.com\/store\/apps\/details\?id=([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)/i
    );
    if (appUrlMatch) {
        return { type: 'app', value: appUrlMatch[1] };
    }

    // Check for developer URL: https://play.google.com/store/apps/dev?id=123456789
    const devUrlMatch = trimmed.match(
        /play\.google\.com\/store\/apps\/dev\?id=(\d+)/i
    );
    if (devUrlMatch) {
        return { type: 'developer', value: devUrlMatch[1] };
    }

    // Check for developer URL with name: https://play.google.com/store/apps/developer?id=Developer+Name
    const devNameUrlMatch = trimmed.match(
        /play\.google\.com\/store\/apps\/developer\?id=([^&\s]+)/i
    );
    if (devNameUrlMatch) {
        // Keep the raw value - it's already URL-encoded from the original URL
        return { type: 'developer', value: devNameUrlMatch[1] };
    }

    // Check for bare package name: com.example.app
    const packageMatch = trimmed.match(
        /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/
    );
    if (packageMatch) {
        return { type: 'package', value: trimmed };
    }

    return null;
}

/**
 * Fetch app info from Play Store page
 */
async function fetchAppInfo(packageName: string): Promise<PlayStoreAppInfo | null> {
    logger.debug('Fetching app info', { packageName });

    try {
        const url = `https://play.google.com/store/apps/details?id=${packageName}&hl=en`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                logger.debug('App not found', { packageName });
                return null;
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();

        // Extract app name from the page title or meta tags
        // The page has: <title>App Name - Apps on Google Play</title>
        const titleMatch = html.match(/<title>([^<]+)\s*[-–]\s*Apps on Google Play/i);
        let appName = packageName; // Default to package name

        if (titleMatch) {
            appName = titleMatch[1].trim();
        } else {
            // Try to find it in the og:title meta tag
            const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
            if (ogTitleMatch) {
                // Strip " - Apps on Google Play" suffix if present
                appName = ogTitleMatch[1].replace(/\s*[-–]\s*Apps on Google Play$/i, '').trim();
            }
        }

        // Extract icon URL (optional)
        let iconUrl: string | undefined;
        const iconMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
        if (iconMatch) {
            iconUrl = iconMatch[1];
        }

        logger.debug('App info fetched', { packageName, appName });

        return {
            packageName,
            name: appName,
            iconUrl,
        };
    } catch (error) {
        logger.error('Failed to fetch app info', { packageName, error });
        return null;
    }
}

/**
 * Fetch all apps from a developer page
 */
async function fetchDeveloperApps(developerId: string): Promise<PlayStoreAppInfo[]> {
    logger.debug('Fetching developer apps', { developerId });

    try {
        // Build URL based on developer ID format
        let url: string;
        if (/^\d+$/.test(developerId)) {
            // Numeric ID uses /dev?id=
            url = `https://play.google.com/store/apps/dev?id=${developerId}&hl=en`;
        } else {
            // Name-based ID uses /developer?id= - value is already URL-encoded
            url = `https://play.google.com/store/apps/developer?id=${developerId}&hl=en`;
        }

        logger.debug('Fetching developer page', { url });

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();

        // Find all app links on the developer page
        // Pattern: /store/apps/details?id=com.example.app
        const packageMatches = html.matchAll(
            /\/store\/apps\/details\?id=([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)/g
        );

        const packageNames = new Set<string>();
        for (const match of packageMatches) {
            packageNames.add(match[1]);
        }

        logger.debug('Found packages on developer page', { developerId, count: packageNames.size });

        if (packageNames.size === 0) {
            return [];
        }

        // Fetch info for each app (with some rate limiting)
        const apps: PlayStoreAppInfo[] = [];
        for (const packageName of packageNames) {
            const appInfo = await fetchAppInfo(packageName);
            if (appInfo) {
                apps.push(appInfo);
            }
            // Small delay to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        logger.debug('Developer apps fetched', { developerId, count: apps.length });
        return apps;
    } catch (error) {
        logger.error('Failed to fetch developer apps', { developerId, error });
        return [];
    }
}

/**
 * Main function to fetch Play Store apps from various input types
 */
export async function fetchPlayStoreApps(inputs: string[]): Promise<{
    apps: PlayStoreAppInfo[];
    errors: string[];
}> {
    const apps: PlayStoreAppInfo[] = [];
    const errors: string[] = [];
    const seenPackages = new Set<string>();

    for (const input of inputs) {
        const parsed = parsePlayStoreInput(input);

        if (!parsed) {
            errors.push(`Invalid input: ${input}`);
            continue;
        }

        try {
            if (parsed.type === 'developer') {
                const devApps = await fetchDeveloperApps(parsed.value);
                if (devApps.length === 0) {
                    errors.push(`No apps found for developer: ${input}`);
                } else {
                    for (const app of devApps) {
                        if (!seenPackages.has(app.packageName)) {
                            seenPackages.add(app.packageName);
                            apps.push(app);
                        }
                    }
                }
            } else {
                // app or package type
                const packageName = parsed.value;
                if (seenPackages.has(packageName)) {
                    continue; // Skip duplicates
                }

                const appInfo = await fetchAppInfo(packageName);
                if (appInfo) {
                    seenPackages.add(packageName);
                    apps.push(appInfo);
                } else {
                    errors.push(`App not found: ${packageName}`);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            errors.push(`Failed to fetch ${input}: ${errorMessage}`);
        }
    }

    return { apps, errors };
}

export const playStoreScraper = {
    parsePlayStoreInput,
    fetchPlayStoreApps,
};
