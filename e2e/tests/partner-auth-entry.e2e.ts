import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('partner auth entry surface is reachable and navigable', async ({ app, screen }) => {
  await app.open('/login');

  await expect(screen.getByRole('heading', 'Sign in to Partner Portal')).toBeVisible();
  await expect(screen.getByLabel('Email Address')).toBeVisible();
  await expect(screen.getByLabel('Password')).toBeVisible();
  await expect(screen.getByRole('button', 'Sign In with Email')).toBeEnabled();

  await screen.getByRole('link', "Don't have an account? Sign Up").click();
  await expect(screen.getByRole('heading', 'Sign up')).toBeVisible();
  await expect(screen.getByLabel('Confirm Password')).toBeVisible();
});
