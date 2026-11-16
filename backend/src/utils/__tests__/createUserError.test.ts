import { mapCreateUserError } from '../createUserError';

describe('mapCreateUserError (ENG-2899)', () => {
  it('maps SDK v2 ConditionalCheckFailedException (code) to 409', () => {
    expect(mapCreateUserError({ code: 'ConditionalCheckFailedException' })).toMatchObject({ status: 409, body: { code: 'email_unavailable' } });
  });
  it('maps SDK v3 ConditionalCheckFailedException (name) to 409', () => {
    expect(mapCreateUserError({ name: 'ConditionalCheckFailedException' }).status).toBe(409);
  });
  it('maps anything else to the unchanged 500', () => {
    for (const e of [new Error('x'), null, undefined, { code: 'ValidationException' }]) {
      expect(mapCreateUserError(e)).toEqual({ status: 500, body: { message: 'Error creating user' } });
    }
  });
});
