/** Simulator activation follows the additive migration and provider verification. */
export function isSimulatorModeEnabled() {
  return process.env.SIMULATOR_MODE_ENABLED?.trim().toLowerCase() === "true";
}
