import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('partner sign-in surface is reachable and interactive', async ({ app, screen }) => {
  await app.open('/login');

  await expect(screen.getByRole('heading', 'Sign in to Partner Portal')).toBeVisible();
  await expect(screen.getByLabel('Email Address')).toBeVisible();
  await expect(screen.getByLabel('Password')).toBeVisible();
  await expect(screen.getByRole('button', 'Sign In with Email')).toBeEnabled();
});
