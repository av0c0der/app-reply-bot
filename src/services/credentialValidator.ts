/**
 * Credential Validator Service
 * Validates Apple .p8 and Google service account JSON credentials
 */

export interface AppleCredentialInfo {
    privateKey: string;
    keyId: string;
    issuerId: string;
}

export interface GoogleCredentialInfo {
    clientEmail: string;
    privateKey: string;
    projectId: string;
}

export interface ValidationResult<T> {
    valid: boolean;
    data?: T;
    error?: string;
}

/**
 * Validates an Apple .p8 private key file content
 */
export function validateAppleP8(content: string): ValidationResult<{ privateKey: string }> {
    const trimmedContent = content.trim();

    // Check for PEM structure
    if (!trimmedContent.includes('-----BEGIN PRIVATE KEY-----')) {
        return {
            valid: false,
            error: 'Invalid .p8 file: Missing "-----BEGIN PRIVATE KEY-----" header',
        };
    }

    if (!trimmedContent.includes('-----END PRIVATE KEY-----')) {
        return {
            valid: false,
            error: 'Invalid .p8 file: Missing "-----END PRIVATE KEY-----" footer',
        };
    }

    // Extract the base64 content between headers
    const base64Match = trimmedContent.match(
        /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----/
    );

    if (!base64Match || !base64Match[1]) {
        return {
            valid: false,
            error: 'Invalid .p8 file: Could not extract private key content',
        };
    }

    // Validate base64 content
    const base64Content = base64Match[1].replace(/\s/g, '');
    if (base64Content.length < 100) {
        return {
            valid: false,
            error: 'Invalid .p8 file: Private key content too short',
        };
    }

    try {
        // Check if it's valid base64
        Buffer.from(base64Content, 'base64');
    } catch {
        return {
            valid: false,
            error: 'Invalid .p8 file: Invalid base64 encoding',
        };
    }

    return {
        valid: true,
        data: { privateKey: trimmedContent },
    };
}

/**
 * Validates Apple Key ID format
 */
export function validateAppleKeyId(keyId: string): ValidationResult<string> {
    const trimmed = keyId.trim();

    // Apple Key IDs are 10 alphanumeric characters
    if (!/^[A-Z0-9]{10}$/.test(trimmed)) {
        return {
            valid: false,
            error: 'Invalid Key ID: Must be exactly 10 alphanumeric characters (e.g., ABC123DEF4)',
        };
    }

    return {
        valid: true,
        data: trimmed,
    };
}

/**
 * Validates Apple Issuer ID format
 */
export function validateAppleIssuerId(issuerId: string): ValidationResult<string> {
    const trimmed = issuerId.trim();

    // Apple Issuer IDs are UUIDs
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) {
        return {
            valid: false,
            error: 'Invalid Issuer ID: Must be a valid UUID (e.g., 12345678-1234-1234-1234-123456789012)',
        };
    }

    return {
        valid: true,
        data: trimmed,
    };
}

/**
 * Validates a Google service account JSON file content
 */
export function validateGoogleServiceAccount(content: string): ValidationResult<GoogleCredentialInfo> {
    let parsed: Record<string, unknown>;

    try {
        parsed = JSON.parse(content);
    } catch {
        return {
            valid: false,
            error: 'Invalid JSON: Could not parse the service account file',
        };
    }

    // Check required fields
    const requiredFields = ['client_email', 'private_key', 'project_id', 'type'];
    const missingFields = requiredFields.filter((field) => !parsed[field]);

    if (missingFields.length > 0) {
        return {
            valid: false,
            error: `Missing required fields: ${missingFields.join(', ')}`,
        };
    }

    // Validate type
    if (parsed.type !== 'service_account') {
        return {
            valid: false,
            error: 'Invalid credential type: Expected "service_account"',
        };
    }

    // Validate client_email format
    const clientEmail = parsed.client_email as string;
    if (!clientEmail.includes('@') || !clientEmail.endsWith('.iam.gserviceaccount.com')) {
        return {
            valid: false,
            error: 'Invalid client_email: Expected format like "name@project.iam.gserviceaccount.com"',
        };
    }

    // Validate private_key format
    const privateKey = parsed.private_key as string;
    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        return {
            valid: false,
            error: 'Invalid private_key: Missing PEM header',
        };
    }

    if (!privateKey.includes('-----END PRIVATE KEY-----')) {
        return {
            valid: false,
            error: 'Invalid private_key: Missing PEM footer',
        };
    }

    return {
        valid: true,
        data: {
            clientEmail,
            privateKey,
            projectId: parsed.project_id as string,
        },
    };
}

/**
 * Validates App Store app ID format
 */
export function validateAppStoreId(appId: string): ValidationResult<string> {
    const trimmed = appId.trim();

    // App Store IDs are numeric
    if (!/^\d+$/.test(trimmed)) {
        return {
            valid: false,
            error: 'Invalid App Store ID: Must be a numeric ID (e.g., 123456789)',
        };
    }

    return {
        valid: true,
        data: trimmed,
    };
}

/**
 * Validates Play Store package name format
 */
export function validatePlayStorePackage(packageName: string): ValidationResult<string> {
    const trimmed = packageName.trim();

    // Android package names follow Java package naming conventions
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(trimmed)) {
        return {
            valid: false,
            error: 'Invalid package name: Must follow format like "com.example.app"',
        };
    }

    return {
        valid: true,
        data: trimmed,
    };
}
