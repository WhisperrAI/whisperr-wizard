export async function completeCheckout(plan: string): Promise<void> {
  await submitOrder(plan);
}
async function submitOrder(_plan: string): Promise<void> {}
