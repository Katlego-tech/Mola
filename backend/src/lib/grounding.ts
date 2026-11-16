/** Extract digit-written numbers, including decimal commas and separate time components. */
export function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(value => Number(value.replace(',', '.')));
}

export function groundedNumbers(output: string, sources: string[]): boolean {
  const allowed = new Set(sources.flatMap(numbersIn));
  return numbersIn(output).every(value => allowed.has(value));
}

export function sameNumbers(a: string, b: string): boolean {
  const first = numbersIn(a).sort((x, y) => x - y);
  const second = numbersIn(b).sort((x, y) => x - y);
  return first.length === second.length && first.every((value, i) => value === second[i]);
}
