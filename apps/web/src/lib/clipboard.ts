// One clipboard routine for every copy affordance. Each screen hand-rolling
// its own try/catch drifted on error copy and the no-clipboard fallback.
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("Clipboard access is unavailable; select and copy it manually.");
  }
  await navigator.clipboard.writeText(text);
}
