/**
 * Interpolate template arguments into a message.
 * Replaces {key} with the corresponding value from args.
 */
export function interpolateMessage(message, args) {
    if (!args)
        return message;
    return message.replace(/\{(\w+)\}/g, (_, key) => {
        const value = args[key];
        return value !== undefined ? String(value) : `{${key}}`;
    });
}
//# sourceMappingURL=interpolate.js.map