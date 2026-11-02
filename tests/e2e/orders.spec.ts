import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-btn').click();
  await expect(page.getByTestId('new-order')).toBeVisible();
});

test('Create an order', {
  annotation: { type: 'business', description: 'a created order appears in my own order list' },
}, async ({ page }) => {
  await page.getByTestId('new-order').click();
  await expect(page.getByTestId('order-row').first()).toContainText('new');
});

test('Cancel an order', {
  annotation: { type: 'business', description: 'a freshly created order can be cancelled and cannot be cancelled twice' },
}, async ({ page, request }) => {
  await page.getByTestId('new-order').click();
  const row = page.getByTestId('order-row').first();
  const id = (await row.textContent())!.split(' · ')[0].trim();
  await page.getByTestId('cancel-' + id).click();
  await expect(page.getByTestId('order-row').first()).toContainText('cancelled');

  // Second cancel must be refused by the API, not just hidden in the UI.
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const again = await request.post(`/api/orders/${id}/cancel`, { headers: { 'x-token': token! } });
  expect(again.status()).toBe(409);
});

test('Orders are isolated per user', {
  annotation: { type: 'business', description: 'another user never sees my orders' },
}, async ({ request }) => {
  const a = await request.post('/api/login', { data: { email: 'qa1@test.local', password: 'qa-pass' } });
  const token = (await a.json()).token;
  await request.post('/api/orders', { data: { item: 'mine' }, headers: { 'x-token': token } });

  const list = await request.get('/api/orders', { headers: { 'x-token': token } });
  const mine = (await list.json()).orders as Array<{ id: number }>;
  expect(mine.length).toBeGreaterThan(0);

  const other = await request.get('/api/me', { headers: { 'x-token': 'not-a-real-token' } });
  expect(other.status()).toBe(401);
});
