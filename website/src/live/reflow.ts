/**
 * Moves the example cards when a result opens or closes beside its query. On a wide screen an open result sits to the
 * right of its query and the card takes a whole row, so the cards after it move down; closing or collapsing the result
 * puts the card back in the grid.
 *
 * `reflow` makes that change in a view transition, so every card glides from where it was to where it lands, and it
 * scrolls the page by however far the changed card moved, so the card stays under the reader's pointer and focus.
 * With reduced motion, or in a browser without view transitions, the change is instant and the scroll still holds the
 * card in place.
 *
 * The cards are named for the transition only while it runs; `global.css` styles the groups (`live-card`).
 */

/** The transition in flight; an older one that finishes late must not clear the names a newer one set. */
let current: ViewTransition | null = null;

/** Applies `update`, which changes how `card` is laid out, and animates every card in its grid to its new place. */
export function reflow(card: HTMLElement, update: () => void): void {
  const top = card.getBoundingClientRect().top;
  const settle = () => {
    update();
    const moved = card.getBoundingClientRect().top - top;
    if (moved !== 0) window.scrollBy({ top: moved, behavior: "instant" });
  };

  if (!animates()) {
    settle();
    return;
  }

  const cards = cardsBeside(card);
  cards.forEach((each, index) => {
    each.style.setProperty("view-transition-name", `live-card-${index}`);
    each.style.setProperty("view-transition-class", "live-card");
  });
  document.documentElement.dataset.liveReflow = "";

  const transition = document.startViewTransition(settle);
  current = transition;
  void transition.finished.finally(() => {
    if (current !== transition) return;
    current = null;
    delete document.documentElement.dataset.liveReflow;
    for (const each of cards) {
      each.style.removeProperty("view-transition-name");
      each.style.removeProperty("view-transition-class");
    }
  });
}

/** `card` and every other card in its grid. */
function cardsBeside(card: HTMLElement): HTMLElement[] {
  const grid = card.parentElement;
  if (grid === null) return [card];
  return [...grid.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-live-card"),
  );
}

function animates(): boolean {
  return "startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
