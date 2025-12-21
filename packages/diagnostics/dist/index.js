/**
 * @tinywhale/diagnostics
 *
 * Shared diagnostic types and definitions for TinyWhale packages.
 */
export { CLI_DIAGNOSTICS, TWCLI001, TWCLI002, TWCLI003, TWCLI004, TWCLI005, TWCLI006, } from "./cli.js";
export { COMPILER_DIAGNOSTICS, TWCHECK001, TWCHECK050, TWGEN001, TWLEX001, TWLEX002, TWLEX003, TWLEX004, TWLEX005, TWPARSE001, } from "./compiler.js";
export { interpolateMessage } from "./interpolate.js";
export { DiagnosticSeverity, } from "./types.js";
import { CLI_DIAGNOSTICS } from "./cli.js";
import { COMPILER_DIAGNOSTICS } from "./compiler.js";
/**
 * All diagnostics from all packages.
 */
export const DIAGNOSTICS = {
    ...COMPILER_DIAGNOSTICS,
    ...CLI_DIAGNOSTICS,
};
/**
 * Get a diagnostic definition by code.
 */
export function getDiagnostic(code) {
    return DIAGNOSTICS[code];
}
/**
 * Check if a code is a valid diagnostic code.
 */
export function isValidDiagnosticCode(code) {
    return code in DIAGNOSTICS;
}
//# sourceMappingURL=index.js.map