import { test, expect } from '@playwright/test';

// The `business` annotation is what the QA handoff report prints for a manual tester.
test('Sign in', {
  annotation: { type: 'business', description: 'correct password signs you in and reveals the order screen' },
}, async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-btn').click();
  await expect(page.getByTestId('login-msg')).toHaveText('Signed in');
  await expect(page.getByTestId('shop-view')).toBeVisible();
});

test('Sign in with a wrong password', {
  annotation: { type: 'business', description: 'wrong password is rejected and the order screen stays hidden' },
}, async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('password').fill('definitely-wrong');
  await page.getByTestId('login-btn').click();
  await expect(page.getByTestId('login-msg')).toHaveText('Wrong email or password');
  await expect(page.getByTestId('shop-view')).toBeHidden();
});

test('Session is required for API access', {
  annotation: { type: 'business', description: 'calling the order API without a session is rejected' },
}, async ({ request }) => {
  const res = await request.get('/api/orders');
  expect(res.status()).toBe(401);
});
