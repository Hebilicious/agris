export function positiveItemId(value: string): number {
  if (!/^\d+$/.test(value)) throw new TypeError("Item ID must be a positive safe integer");
  const itemId = Number(value);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new TypeError("Item ID must be a positive safe integer");
  return itemId;
}
