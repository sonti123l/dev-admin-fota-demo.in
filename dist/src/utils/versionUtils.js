/**
 * Version utility functions for Semantic Versioning (SemVer)
 * validation, comparison, and manipulation.
 */
/**
 * Parses a version string into an array of numbers.
 * Supports "1.0.0", "v1.2.3", "2.1", "1.2.3.4", etc.
 * Normalizes 2 parts to 3 parts (e.g. "1.2" -> [1, 2, 0]).
 * Returns null if the format is invalid.
 */
export function parseVersion(version) {
    if (!version || typeof version !== "string")
        return null;
    const trimmed = version.trim();
    if (!trimmed)
        return null;
    // Strict regex: optional 'v' or 'V', followed by dot-separated digits
    const semverRegex = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i;
    const match = trimmed.match(semverRegex);
    if (!match)
        return null;
    const rawParts = trimmed.replace(/^v/i, "").split(".");
    const numbers = [];
    for (const part of rawParts) {
        if (!/^\d+$/.test(part))
            return null;
        const num = parseInt(part, 10);
        if (isNaN(num) || num < 0)
            return null;
        numbers.push(num);
    }
    while (numbers.length < 3) {
        numbers.push(0);
    }
    return numbers;
}
/**
 * Compares two versions numerically.
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 *  null if either version is invalid
 */
export function compareVersions(v1, v2) {
    const p1 = parseVersion(v1);
    const p2 = parseVersion(v2);
    if (!p1 || !p2)
        return null;
    const maxLen = Math.max(p1.length, p2.length);
    for (let i = 0; i < maxLen; i++) {
        const num1 = p1[i] ?? 0;
        const num2 = p2[i] ?? 0;
        if (num1 > num2)
            return 1;
        if (num1 < num2)
            return -1;
    }
    return 0;
}
/**
 * Checks if newVersion is strictly greater than oldVersion.
 * If oldVersion is missing, "0.0.0", or "unknown", returns true if newVersion > 0.0.0.
 */
export function isVersionGreater(newVersion, oldVersion) {
    if (!newVersion)
        return false;
    const pNew = parseVersion(newVersion);
    if (!pNew)
        return false;
    const cleanOld = (oldVersion || "").trim().toLowerCase();
    if (!cleanOld || cleanOld === "0.0.0" || cleanOld === "unknown" || cleanOld === "—") {
        return pNew.some((n) => n > 0);
    }
    const cmp = compareVersions(newVersion, cleanOld);
    return cmp !== null && cmp > 0;
}
/**
 * Comprehensive validation function for new versions against current version.
 */
export function validateVersion(newVersion, currentVersion) {
    if (!newVersion || !newVersion.trim()) {
        return { isValid: false, isGreater: false };
    }
    const trimmedNew = newVersion.trim();
    const pNew = parseVersion(trimmedNew);
    if (!pNew) {
        return {
            isValid: false,
            isGreater: false,
            error: `Invalid version format "${trimmedNew}". Use Semantic Versioning (e.g. 1.0.0 or v1.0.0).`,
        };
    }
    const cleanCurrent = (currentVersion || "").trim();
    if (!cleanCurrent ||
        cleanCurrent === "0.0.0" ||
        cleanCurrent.toLowerCase() === "unknown" ||
        cleanCurrent === "—") {
        const hasPositive = pNew.some((n) => n > 0);
        if (!hasPositive) {
            return {
                isValid: false,
                isGreater: false,
                error: "Version must be greater than 0.0.0.",
            };
        }
        return {
            isValid: true,
            isGreater: true,
        };
    }
    const cmp = compareVersions(trimmedNew, cleanCurrent);
    if (cmp === null) {
        return {
            isValid: true,
            isGreater: true,
        };
    }
    if (cmp === 0) {
        return {
            isValid: false,
            isGreater: false,
            error: `New version (${trimmedNew}) cannot be the same as current version (${cleanCurrent}).`,
        };
    }
    if (cmp < 0) {
        return {
            isValid: false,
            isGreater: false,
            error: `Downgrade not allowed. New version (${trimmedNew}) must be strictly greater than current version (${cleanCurrent}).`,
        };
    }
    return {
        isValid: true,
        isGreater: true,
    };
}
