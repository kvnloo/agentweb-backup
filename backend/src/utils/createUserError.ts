/**
 * ENG-2899 (ENG-682 AC4): map a userDb.createUser failure to an HTTP response.
 *
 * createUser writes with `attribute_not_exists(email)`, so an email that
 * already occupies the user PK (active account OR a tombstone left by an email
 * change) surfaces as DynamoDB `ConditionalCheckFailedException`. That used to
 * fall into the generic 500 "Error creating user", which gives the person no
 * way forward. The message deliberately does not say whether the row is a
 * tombstone or a live account — it reveals no more than login already does.
 */
export const EMAIL_UNAVAILABLE_CODE = "email_unavailable";

export interface CreateUserErrorResponse {
  status: number;
  body: { message: string; code?: string };
}

export function isConditionalCheckFailed(error: unknown): boolean {
  const e = error as { code?: unknown; name?: unknown } | null | undefined;
  return (
    e?.code === "ConditionalCheckFailedException" ||
    e?.name === "ConditionalCheckFailedException"
  );
}

export function mapCreateUserError(error: unknown): CreateUserErrorResponse {
  if (isConditionalCheckFailed(error)) {
    return {
      status: 409,
      body: {
        code: EMAIL_UNAVAILABLE_CODE,
        message:
          "This email can't be used to create a new account right now. Please try again in a minute, and contact support if it keeps happening.",
      },
    };
  }
  return { status: 500, body: { message: "Error creating user" } };
}
