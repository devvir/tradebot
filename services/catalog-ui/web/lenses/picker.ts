/**
 * What the lens picker says while nothing is chosen. **A list never read is not
 * an empty one**, so it says which of the two it is.
 */
export const lensPlaceholder = (choices: number, unread: boolean): string =>
  (choices > 0 ? 'Choose a lens' : unread ? 'Lenses not read' : 'No lenses yet');
