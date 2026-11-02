## ENG-673: how many contacts of a Smartlead push replied, bounced or unsubscribed (2026-11-02)

The push run item (`AW-SmartleadPushRuns`, sk `RUN`) now carries an optional `events` map `{replied, bounced, unsubscribed}`, one count per CONTACT (a second reply from the same contact does not count again; a temporary bounce is not counted). It is added to by `SmartleadPushRunDb.countContactEvent` and shown in the push run view (`RunView.events`).

- Written only by the Smartlead event handler (`smartleadEventService.ts`), after the reply is saved and alerted, or after the opt-out or bounce block is written, inside a try/catch: a failing counter is logged and never changes what happens to the contact.
- No lease is needed: replies and opt-outs arrive long after a push has finished. The update only adds to the counter (`SET events.k = if_not_exists(events.k, 0) + 1`); the first event of a run (or of a run made before this) creates the map with a separate conditional write that never overwrites an existing one.
- Display only. The contact's own engagements remain the record. A crash between saving an event and counting it leaves the count one short; there is no recount.
- Runs made before this have no `events` and the view shows nothing for them. No table, index or key change; the IAM grant (UpdateItem on the table) already covers it.
