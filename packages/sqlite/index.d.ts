/** The SQLite every library in this package is built from. */
export declare const SQLITE_VERSION: string

/** The library for this platform, or for the one described, when this package has one. */
export declare const libraryFor: (target?: { platform?: string; arch?: string; musl?: boolean }) => string | undefined
