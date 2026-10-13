## ENG-1539: create_google_doc typed error classification (2026-10-13)

createGoogleDoc now returns `error_type` (auth_expired/permission/not_found/validation/api/internal). 401/invalid_grant/missing connection map to a reconnect hint instead of misleading folder_id advice on root-Drive calls. Regression test: backend/src/__tests__/emma/createGoogleDocErrors.test.ts.
