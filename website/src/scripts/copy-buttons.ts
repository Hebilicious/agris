/**
 * One listener for every copy button on the page: a button with a `data-copy` attribute copies that attribute's text
 * and says "Copied" for a moment. Components import this module from their scripts; the bundler evaluates it once, so
 * the listener is added once however many components use it.
 */
document.addEventListener("click", async (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest<HTMLButtonElement>("button[data-copy]") : null;
  if (button === null || button.dataset.copy === undefined) return;
  const label = button.dataset.label ?? button.textContent ?? "Copy";
  button.dataset.label = label;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
});
