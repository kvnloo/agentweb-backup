/**
 * Whether a horizontally-scrollable element still has more content past its right edge, given
 * its current scroll geometry (ENG-2221). A 1px epsilon absorbs sub-pixel rounding so a table
 * that exactly fits, or is scrolled all the way to its end, does not show a permanent shadow.
 *
 * Kept in its own module (rather than exported from EvalV2Tab.tsx) so that file exports only
 * React components, per react-refresh/only-export-components.
 */
export function hasMoreToScrollRight(state: { scrollWidth: number; clientWidth: number; scrollLeft: number }): boolean {
  return state.scrollWidth - state.clientWidth - state.scrollLeft > 1;
}
