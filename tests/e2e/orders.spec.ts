import { test, expect, type Page } from '@playwright/test';

// These tests never assert on global state: the database keeps orders from earlier runs,
// so each test creates its own order and tracks that specific row. An e2e suite that only
// passes on a fresh database is a flaky suite, and a flaky gate gets bypassed.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-btn').click();
  await expect(page.getByTestId('new-order')).toBeVisible();
});

const rowCount = (page: Page) => page.getByTestId('order-row').count();

async function createOrder(page: Page): Promise<string> {
  const before = await rowCount(page);
  await page.getByTestId('new-order').click();
  await expect(page.getByTestId('order-row')).toHaveCount(before + 1);
  const last = page.getByTestId('order-row').last();
  return (await last.textContent())!.split(' · ')[0].trim();
}

test('Create an order', {
  annotation: { type: 'business', description: 'a created order appears in my own order list' },
}, async ({ page }) => {
  const id = await createOrder(page);
  const row = page.getByTestId('order-row').filter({ hasText: id }).first();
  await expect(row).toContainText('new');
  await expect(row).toContainText('T-shirt');
});

test('Cancel an order', {
  annotation: { type: 'business', description: 'a freshly created order can be cancelled and cannot be cancelled twice' },
}, async ({ page, request }) => {
  const id = await createOrder(page);
  await page.getByTestId('cancel-' + id).click();
  await expect(page.getByTestId('order-row').filter({ hasText: id }).first()).toContainText('cancelled');
  await expect(page.getByTestId('cancel-' + id)).toHaveCount(0);

  // A second cancel must be refused by the API, not merely hidden by the UI.
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const again = await request.post(`/api/orders/${id}/cancel`, { headers: { 'x-token': token! } });
  expect(again.status()).toBe(409);
});

test('Orders are isolated per user', {
  annotation: { type: 'business', description: 'another user never sees my orders' },
}, async ({ request }) => {
  const mine = await request.post('/api/login', { data: { email: 'qa1@test.local', password: 'qa-pass' } });
  const token = (await mine.json()).token;
  const created = await request.post('/api/orders', { data: { item: 'mine' }, headers: { 'x-token': token } });
  expect(created.status()).toBe(201);

  const list = await request.get('/api/orders', { headers: { 'x-token': token } });
  const orders = (await list.json()).orders as Array<{ id: number }>;
  expect(orders.length).toBeGreaterThan(0);

  const other = await request.get('/api/me', { headers: { 'x-token': 'not-a-real-token' } });
  expect(other.status()).toBe(401);
});
