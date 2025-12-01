/**
 * Logger Utility
 * Centralized logging with debug mode support
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
    prefix?: string;
}

class Logger {
    private debugMode: boolean;
    private prefix: string;

    constructor(options: LoggerOptions = {}) {
        this.debugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
        this.prefix = options.prefix || '';
    }

    private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
        const timestamp = new Date().toISOString();
        const prefix = this.prefix ? `[${this.prefix}]` : '';
        return `${timestamp} ${level.toUpperCase()} ${prefix} ${message}`;
    }

    /**
     * Debug level logging - only shown when DEBUG=true or NODE_ENV=development
     */
    debug(message: string, ...args: unknown[]): void {
        if (this.debugMode) {
            console.debug(this.formatMessage('debug', message), ...args);
        }
    }

    /**
     * Info level logging - always shown
     */
    info(message: string, ...args: unknown[]): void {
        console.log(this.formatMessage('info', message), ...args);
    }

    /**
     * Warning level logging - always shown
     */
    warn(message: string, ...args: unknown[]): void {
        console.warn(this.formatMessage('warn', message), ...args);
    }

    /**
     * Error level logging - always shown
     */
    error(message: string, ...args: unknown[]): void {
        console.error(this.formatMessage('error', message), ...args);
    }

    /**
     * Create a child logger with a specific prefix
     */
    child(prefix: string): Logger {
        const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        const childLogger = new Logger({ prefix: childPrefix });
        childLogger.debugMode = this.debugMode;
        return childLogger;
    }

    /**
     * Check if debug mode is enabled
     */
    isDebugEnabled(): boolean {
        return this.debugMode;
    }

    /**
     * Log function entry with parameters (debug level)
     */
    debugFn(fnName: string, params?: Record<string, unknown>): void {
        if (this.debugMode) {
            const paramStr = params ? ` with params: ${JSON.stringify(params)}` : '';
            this.debug(`→ ${fnName}()${paramStr}`);
        }
    }

    /**
     * Log function exit with result (debug level)
     */
    debugFnResult(fnName: string, result?: unknown): void {
        if (this.debugMode) {
            const resultStr = result !== undefined ? `: ${JSON.stringify(result)}` : '';
            this.debug(`← ${fnName}() returned${resultStr}`);
        }
    }

    /**
     * Log API request (debug level)
     */
    debugRequest(method: string, url: string, body?: unknown): void {
        if (this.debugMode) {
            this.debug(`API Request: ${method} ${url}`, body ? { body } : '');
        }
    }

    /**
     * Log API response (debug level)
     */
    debugResponse(method: string, url: string, status: number, body?: unknown): void {
        if (this.debugMode) {
            this.debug(`API Response: ${method} ${url} -> ${status}`, body ? { body } : '');
        }
    }

    /**
     * Log database operation (debug level)
     */
    debugDb(operation: string, table: string, details?: Record<string, unknown>): void {
        if (this.debugMode) {
            this.debug(`DB ${operation} on ${table}`, details || '');
        }
    }
}

// Create and export the main logger instance
export const logger = new Logger();

// Export child loggers for different modules
export const botLogger = logger.child('Bot');
export const schedulerLogger = logger.child('Scheduler');
export const commandsLogger = logger.child('Commands');
export const reviewLogger = logger.child('Review');
export const llmLogger = logger.child('LLM');
export const supabaseLogger = logger.child('Supabase');
export const appStoreLogger = logger.child('AppStore');
export const playStoreLogger = logger.child('PlayStore');
export const sceneLogger = logger.child('Scene');

export default logger;
