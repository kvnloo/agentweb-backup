export interface MetaAdAccount {
  id: string;
  name: string;
  account_id: string;
  currency: string;
  account_status: number;
}

/**
 * Instagram Professional account (Business or Creator).
 * Used in two contexts:
 *  - Method A: linked to an ad account via /act_{id}/instagram_accounts — for instagram_user_id in ads
 *  - Method C: returned by Instagram Business Login via /me — for organic publishing
 */
export interface MetaInstagramAccount {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string; // Page-specific access token
  category: string;
  tasks?: string[];
}

export interface MetaConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export interface MetaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}
